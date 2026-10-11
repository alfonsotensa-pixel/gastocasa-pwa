// Motor de Sincronización en la Nube (Multi-Móvil) con Supabase REST - Cero Dependencias
import { db } from './db.js';
import { sanitizeTransaction } from './models.js';

export const SUPABASE_SETUP_SQL = `-- Script de Configuración para GastoCasa en Supabase (Copiar y Ejecutar en SQL Editor)

create table if not exists households (
  id text primary key,
  name text not null default 'Hogar Compartido',
  created_at timestamptz default now()
);

create table if not exists members (
  id text not null,
  household_id text not null,
  name text not null,
  avatar text default '👤',
  color text default '#0284C7',
  is_active boolean default true,
  updated_at timestamptz default now(),
  primary key (id, household_id)
);

create table if not exists categories (
  id text not null,
  household_id text not null,
  name text not null,
  icon text default '📦',
  color text default '#0284C7',
  monthly_budget numeric default 0,
  is_system boolean default false,
  is_archived boolean default false,
  display_order integer default 0,
  updated_at timestamptz default now(),
  primary key (id, household_id)
);

create table if not exists transactions (
  id text not null,
  household_id text not null,
  type text default 'expense',
  amount numeric not null default 0,
  category_id text not null,
  paid_by_member_id text not null,
  split_type text default 'SHARED_EQUAL',
  beneficiary_member_ids jsonb default '[]'::jsonb,
  date text not null,
  note text default '',
  is_settlement boolean default false,
  created_at bigint default 0,
  updated_at timestamptz default now(),
  primary key (id, household_id)
);

-- Políticas de Seguridad RLS para permitir lectura y escritura anónima con clave pública (anon)
alter table households enable row level security;
alter table members enable row level security;
alter table categories enable row level security;
alter table transactions enable row level security;

create policy "Acceso público households" on households for all using (true) with check (true);
create policy "Acceso público members" on members for all using (true) with check (true);
create policy "Acceso público categories" on categories for all using (true) with check (true);
create policy "Acceso público transactions" on transactions for all using (true) with check (true);
`;

export class CloudSyncEngine {
  constructor(appController) {
    this.app = appController;
    this.config = {
      url: '',
      anonKey: '',
      householdCode: '',
      enabled: false,
      lastSyncTime: null
    };
    this.pollInterval = null;
    this.isSyncing = false;
  }

  init(settings = {}) {
    // Cargar configuración guardada en settings
    this.config.url = (settings.syncUrl || '').replace(/\/+$/, '');
    this.config.anonKey = settings.syncKey || '';
    this.config.householdCode = (settings.syncCode || '').trim().toUpperCase();
    this.config.enabled = Boolean(this.config.url && this.config.anonKey && this.config.householdCode);

    // Comprobar parámetros en la URL (ej. invitación compartida por WhatsApp)
    this.checkInviteUrlParams();

    if (this.config.enabled) {
      this.startAutoSync();
    }
  }

  // Verifica si el enlace se abrió con ?sync_url=...&sync_key=...&sync_code=...
  checkInviteUrlParams() {
    try {
      const params = new URLSearchParams(window.location.search);
      const url = params.get('sync_url');
      const key = params.get('sync_key');
      const code = params.get('sync_code');

      if (url && key && code) {
        this.config.url = decodeURIComponent(url).replace(/\/+$/, '');
        this.config.anonKey = decodeURIComponent(key);
        this.config.householdCode = decodeURIComponent(code).trim().toUpperCase();
        this.config.enabled = true;

        // Guardar de inmediato en settings
        this.saveConfigToSettings().then(() => {
          // Limpiar la URL para que no queden credenciales en el historial
          const cleanUrl = window.location.origin + window.location.pathname;
          window.history.replaceState({}, document.title, cleanUrl);

          this.app.pwaManager.showToast(`¡Hogar ${this.config.householdCode} vinculado desde el enlace!`);
          this.syncNow();
        });
      }
    } catch (e) {
      console.warn('[Sync] Error analizando parámetros de invitación:', e);
    }
  }

  async saveConfigToSettings() {
    const settings = this.app.settings || { id: 'main_settings' };
    settings.syncUrl = this.config.url;
    settings.syncKey = this.config.anonKey;
    settings.syncCode = this.config.householdCode;
    await db.put('settings', settings);
    this.app.settings = settings;
    this.updateUIStatus();
  }

  getHeaders() {
    return {
      'apikey': this.config.anonKey,
      'Authorization': `Bearer ${this.config.anonKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates'
    };
  }

  // Iniciar ciclo de sincronización automática periódica y por foco
  startAutoSync() {
    this.stopAutoSync();

    // Sincronizar de inmediato
    this.syncNow().catch(() => {});

    // Sondeo cada 15 segundos cuando la ventana está activa
    this.pollInterval = setInterval(() => {
      if (navigator.onLine && !this.isSyncing) {
        this.syncNow().catch(() => {});
      }
    }, 15000);

    // Sincronizar al recuperar foco o volver a estar online
    window.addEventListener('focus', () => this.syncNow().catch(() => {}));
    window.addEventListener('online', () => this.syncNow().catch(() => {}));
  }

  stopAutoSync() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  // --- SINCRONIZACIÓN COMPLETA BIDIRECCIONAL ---
  async syncNow() {
    if (!this.config.enabled || this.isSyncing) return;
    if (!navigator.onLine) {
      console.log('[Sync] Dispositivo offline, sincronización aplazada');
      return;
    }

    this.isSyncing = true;
    this.updateUIStatus();

    try {
      const code = this.config.householdCode;

      // 1. Asegurar que existe el hogar en la tabla households
      await fetch(`${this.config.url}/rest/v1/households`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify([{ id: code, name: this.app.settings?.householdName || 'Hogar Compartido' }])
      });

      // 2. SUBIR (PUSH) DATOS LOCALES A LA NUBE
      const [localMembers, localCategories, localTransactions] = await Promise.all([
        db.getAll('members'),
        db.getAll('categories'),
        db.getAll('transactions')
      ]);

      if (localMembers.length > 0) {
        const payloadMembers = localMembers.map(m => ({
          id: m.id,
          household_id: code,
          name: m.name,
          avatar: m.avatar || '👤',
          color: m.color || '#0284C7',
          is_active: m.isActive !== false,
          updated_at: new Date().toISOString()
        }));
        await fetch(`${this.config.url}/rest/v1/members`, {
          method: 'POST',
          headers: this.getHeaders(),
          body: JSON.stringify(payloadMembers)
        });
      }

      if (localCategories.length > 0) {
        const payloadCategories = localCategories.map(c => ({
          id: c.id,
          household_id: code,
          name: c.name,
          icon: c.icon || '📦',
          color: c.color || '#0284C7',
          monthly_budget: c.monthlyBudget || 0,
          is_system: Boolean(c.isSystem),
          is_archived: Boolean(c.isArchived),
          display_order: c.displayOrder || 0,
          updated_at: new Date().toISOString()
        }));
        await fetch(`${this.config.url}/rest/v1/categories`, {
          method: 'POST',
          headers: this.getHeaders(),
          body: JSON.stringify(payloadCategories)
        });
      }

      if (localTransactions.length > 0) {
        const payloadTx = localTransactions.map(t => ({
          id: t.id,
          household_id: code,
          type: t.type || 'expense',
          amount: t.amount,
          category_id: t.categoryId,
          paid_by_member_id: t.paidByMemberId,
          split_type: t.splitType || 'SHARED_EQUAL',
          beneficiary_member_ids: t.beneficiaryMemberIds || [],
          date: t.date,
          note: t.note || '',
          is_settlement: Boolean(t.isSettlement),
          created_at: t.createdAt || Date.now(),
          updated_at: new Date().toISOString()
        }));
        await fetch(`${this.config.url}/rest/v1/transactions`, {
          method: 'POST',
          headers: this.getHeaders(),
          body: JSON.stringify(payloadTx)
        });
      }

      // 3. BAJAR (PULL) DATOS ACTUALIZADOS DE LA NUBE
      const [resMembers, resCategories, resTx] = await Promise.all([
        fetch(`${this.config.url}/rest/v1/members?household_id=eq.${encodeURIComponent(code)}&select=*`, {
          headers: this.getHeaders()
        }),
        fetch(`${this.config.url}/rest/v1/categories?household_id=eq.${encodeURIComponent(code)}&select=*`, {
          headers: this.getHeaders()
        }),
        fetch(`${this.config.url}/rest/v1/transactions?household_id=eq.${encodeURIComponent(code)}&select=*`, {
          headers: this.getHeaders()
        })
      ]);

      if (resMembers.ok && resCategories.ok && resTx.ok) {
        const [cloudMembers, cloudCategories, cloudTx] = await Promise.all([
          resMembers.json(),
          resCategories.json(),
          resTx.json()
        ]);

        // Guardar miembros de la nube en IndexedDB local
        for (const m of cloudMembers) {
          await db.put('members', {
            id: m.id,
            name: m.name,
            avatar: m.avatar,
            color: m.color,
            isActive: m.is_active,
            createdAt: m.created_at || new Date().toISOString()
          });
        }

        // Guardar categorías de la nube en IndexedDB local
        for (const c of cloudCategories) {
          await db.put('categories', {
            id: c.id,
            name: c.name,
            icon: c.icon,
            color: c.color,
            monthlyBudget: Number(c.monthly_budget) || 0,
            isSystem: Boolean(c.is_system),
            isArchived: Boolean(c.is_archived),
            displayOrder: Number(c.display_order) || 0
          });
        }

        // Guardar transacciones de la nube en IndexedDB local
        for (const t of cloudTx) {
          await db.put('transactions', sanitizeTransaction({
            id: t.id,
            type: t.type,
            amount: Number(t.amount) || 0,
            categoryId: t.category_id,
            paidByMemberId: t.paid_by_member_id,
            splitType: t.split_type,
            beneficiaryMemberIds: t.beneficiary_member_ids,
            date: t.date,
            note: t.note,
            isSettlement: t.is_settlement,
            createdAt: Number(t.created_at) || Date.now()
          }));
        }

        this.config.lastSyncTime = new Date();
        await this.app.refreshData();
        this.app.renderCurrentView();
      }
    } catch (err) {
      console.warn('[Sync] Error durante la sincronización:', err);
    } finally {
      this.isSyncing = false;
      this.updateUIStatus();
    }
  }

  // Envío rápido individual de un movimiento recién creado/modificado
  async pushTransaction(tx) {
    if (!this.config.enabled || !navigator.onLine) return;
    try {
      await fetch(`${this.config.url}/rest/v1/transactions`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify([{
          id: tx.id,
          household_id: this.config.householdCode,
          type: tx.type || 'expense',
          amount: tx.amount,
          category_id: tx.categoryId,
          paid_by_member_id: tx.paidByMemberId,
          split_type: tx.splitType || 'SHARED_EQUAL',
          beneficiary_member_ids: tx.beneficiaryMemberIds || [],
          date: tx.date,
          note: tx.note || '',
          is_settlement: Boolean(tx.isSettlement),
          created_at: tx.createdAt || Date.now(),
          updated_at: new Date().toISOString()
        }])
      });
    } catch (e) {
      console.warn('[Sync] Error al enviar transacción:', e);
    }
  }

  // Generar enlace para compartir por WhatsApp con configuración en 1 clic
  generateShareableLink() {
    if (!this.config.enabled) return '';
    const baseUrl = window.location.origin + window.location.pathname;
    const params = new URLSearchParams({
      sync_url: this.config.url,
      sync_key: this.config.anonKey,
      sync_code: this.config.householdCode
    });
    return `${baseUrl}?${params.toString()}`;
  }

  updateUIStatus() {
    const badge = document.getElementById('sync-status-badge');
    if (!badge) return;

    if (!this.config.enabled) {
      badge.innerHTML = '⚪ Modo Local (Solo este móvil)';
      badge.style.color = 'var(--ink-secondary)';
      badge.style.background = 'var(--surface-muted)';
    } else if (this.isSyncing) {
      badge.innerHTML = '🔄 Sincronizando con la nube...';
      badge.style.color = '#0284C7';
      badge.style.background = '#E0F2FE';
    } else {
      const timeStr = this.config.lastSyncTime 
        ? `(${this.config.lastSyncTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })})` 
        : '';
      badge.innerHTML = `☁️ Conectado: <b>${this.config.householdCode}</b> ${timeStr}`;
      badge.style.color = '#059669';
      badge.style.background = '#DCFCE7';
    }
  }
}
