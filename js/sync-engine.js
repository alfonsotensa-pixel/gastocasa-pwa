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

-- Habilitar Row Level Security (RLS)
alter table households enable row level security;
alter table members enable row level security;
alter table categories enable row level security;
alter table transactions enable row level security;

-- Políticas de Seguridad RLS idempotentes (permiten lectura y escritura anónima con clave pública anon)
drop policy if exists "Acceso público households" on households;
create policy "Acceso público households" on households for all using (true) with check (true);

drop policy if exists "Acceso público members" on members;
create policy "Acceso público members" on members for all using (true) with check (true);

drop policy if exists "Acceso público categories" on categories;
create policy "Acceso público categories" on categories for all using (true) with check (true);

drop policy if exists "Acceso público transactions" on transactions;
create policy "Acceso público transactions" on transactions for all using (true) with check (true);

-- Índices de consulta rápida
create index if not exists idx_transactions_household on transactions (household_id);
create index if not exists idx_members_household on members (household_id);
create index if not exists idx_categories_household on categories (household_id);
`;

export class CloudSyncEngine {
  constructor(appController) {
    this.app = appController;
    this.config = {
      url: '',
      anonKey: '',
      householdCode: '',
      enabled: false,
      lastSyncTime: null,
      lastError: null
    };
    this.pollInterval = null;
    this.isSyncing = false;
    this._onFocus = null;
    this._onOnline = null;
    this._onVisibility = null;
  }

  init(settings = {}) {
    // Cargar configuración guardada en settings
    this.config.url = (settings.syncUrl || '').trim().replace(/\/+$/, '');
    this.config.anonKey = (settings.syncKey || '').trim();
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
        this.config.url = decodeURIComponent(url).trim().replace(/\/+$/, '');
        this.config.anonKey = decodeURIComponent(key).trim();
        this.config.householdCode = decodeURIComponent(code).trim().toUpperCase();
        this.config.enabled = true;

        // Guardar de inmediato en settings
        this.saveConfigToSettings().then(() => {
          // Limpiar la URL para que no queden credenciales en el historial
          const cleanUrl = window.location.origin + window.location.pathname;
          window.history.replaceState({}, document.title, cleanUrl);

          this.app.pwaManager.showToast(`¡Hogar ${this.config.householdCode} vinculado desde el enlace!`);
          this.syncNow(true);
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

  getHeaders(includeUpsert = true) {
    const headers = {
      'apikey': this.config.anonKey,
      'Authorization': `Bearer ${this.config.anonKey}`,
      'Content-Type': 'application/json'
    };
    if (includeUpsert) {
      headers['Prefer'] = 'resolution=merge-duplicates';
    }
    return headers;
  }

  // Registro de eliminaciones pendientes (para modo offline o resiliencia de red)
  async recordPendingDelete(type, id) {
    const settings = this.app.settings || { id: 'main_settings' };
    const key = `pendingDeletes_${type}`;
    settings[key] = Array.isArray(settings[key]) ? settings[key] : [];
    if (!settings[key].includes(id)) {
      settings[key].push(id);
      await db.put('settings', settings);
      this.app.settings = settings;
    }
  }

  async clearPendingDelete(type, id) {
    const settings = this.app.settings || {};
    const key = `pendingDeletes_${type}`;
    if (Array.isArray(settings[key])) {
      settings[key] = settings[key].filter(item => item !== id);
      await db.put('settings', settings);
      this.app.settings = settings;
    }
  }

  async processPendingDeletes() {
    if (!this.config.enabled || !navigator.onLine) return;
    const settings = this.app.settings || {};
    const code = this.config.householdCode;

    for (const type of ['members', 'categories', 'transactions']) {
      const key = `pendingDeletes_${type}`;
      const list = settings[key] || [];
      if (list.length > 0) {
        const remaining = [];
        for (const id of list) {
          try {
            const res = await fetch(`${this.config.url}/rest/v1/${type}?id=eq.${encodeURIComponent(id)}&household_id=eq.${encodeURIComponent(code)}`, {
              method: 'DELETE',
              headers: this.getHeaders(false)
            });
            if (!res.ok && res.status !== 404) {
              remaining.push(id);
            }
          } catch (e) {
            remaining.push(id);
          }
        }
        settings[key] = remaining;
        await db.put('settings', settings);
        this.app.settings = settings;
      }
    }
  }

  // Diagnóstico completo de conexión con Supabase
  async testConnection(customUrl, customKey, customCode) {
    const url = (customUrl || this.config.url || '').trim().replace(/\/+$/, '');
    const key = (customKey || this.config.anonKey || '').trim();
    const code = (customCode || this.config.householdCode || '').trim().toUpperCase();

    if (!url || !key || !code) {
      return {
        ok: false,
        status: 'CAMPOS_INCOMPLETOS',
        message: 'Debes completar el Código de Hogar, la Project URL y la Anon Public Key de Supabase.'
      };
    }

    if (!url.startsWith('https://')) {
      return {
        ok: false,
        status: 'URL_INVALIDA',
        message: 'La URL de Supabase debe comenzar con https:// (Ejemplo: https://xyzcompany.supabase.co)'
      };
    }

    const testHeaders = {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json'
    };

    try {
      // 1. Probar URL y clave comprobando si responde el endpoint REST
      let resHouseholds;
      try {
        resHouseholds = await fetch(`${url}/rest/v1/households?select=id&limit=1`, {
          method: 'GET',
          headers: testHeaders
        });
      } catch (netErr) {
        return {
          ok: false,
          status: 'ERROR_RED',
          message: `No se puede contactar con la URL proporcionada (${netErr.message || 'Error de red'}). Verifica la URL y tu conexión.`
        };
      }

      if (resHouseholds.status === 401) {
        return {
          ok: false,
          status: 'CLAVE_INVALIDA',
          message: 'Error 401 (Unauthorized): La Anon Public Key es inválida o expiró. Cópiala de nuevo desde Supabase (Project Settings > API).'
        };
      }

      if (resHouseholds.status === 404) {
        return {
          ok: false,
          status: 'TABLAS_NO_EXISTEN',
          message: 'Error 404: La tabla "households" NO existe en tu Supabase. Debes ejecutar el Script SQL en Supabase SQL Editor para crear las tablas requeridas.'
        };
      }

      // 2. Verificar existencia de las otras 3 tablas
      const [resMembers, resCategories, resTx] = await Promise.all([
        fetch(`${url}/rest/v1/members?select=id&limit=1`, { headers: testHeaders }),
        fetch(`${url}/rest/v1/categories?select=id&limit=1`, { headers: testHeaders }),
        fetch(`${url}/rest/v1/transactions?select=id&limit=1`, { headers: testHeaders })
      ]);

      const missing = [];
      if (!resHouseholds.ok) missing.push('households');
      if (!resMembers.ok) missing.push('members');
      if (!resCategories.ok) missing.push('categories');
      if (!resTx.ok) missing.push('transactions');

      if (missing.length > 0) {
        return {
          ok: false,
          status: 'TABLAS_FALTANTES',
          message: `Faltan tablas por crear en Supabase: [${missing.join(', ')}]. Pulsa "COPIAR SCRIPT SQL" y ejecútalo en Supabase > SQL Editor.`
        };
      }

      // 3. Probar permisos de escritura RLS
      const upsertHeaders = { ...testHeaders, 'Prefer': 'resolution=merge-duplicates' };
      const resWrite = await fetch(`${url}/rest/v1/households?on_conflict=id`, {
        method: 'POST',
        headers: upsertHeaders,
        body: JSON.stringify([{ id: code, name: this.app.settings?.householdName || 'Hogar Compartido' }])
      });

      if (!resWrite.ok) {
        const errJson = await resWrite.json().catch(() => ({}));
        return {
          ok: false,
          status: 'ERROR_PERMISOS_RLS',
          message: `Error al escribir en Supabase (${resWrite.status}): ${errJson.message || 'Verifica las políticas RLS ejecutando el Script SQL.'}`
        };
      }

      return {
        ok: true,
        status: 'EXITO',
        message: '¡Conexión y tablas 100% verificadas en Supabase! Lectura y escritura activas.'
      };
    } catch (err) {
      return {
        ok: false,
        status: 'ERROR_DESCONOCIDO',
        message: `Error inesperado: ${err.message}`
      };
    }
  }

  // Iniciar ciclo de sincronización automática periódica y por visibilidad
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

    // Escuchadores móviles y de escritorio
    this._onFocus = () => {
      if (navigator.onLine && !this.isSyncing) this.syncNow().catch(() => {});
    };
    this._onOnline = () => {
      if (!this.isSyncing) this.syncNow().catch(() => {});
    };
    this._onVisibility = () => {
      if (document.visibilityState === 'visible' && navigator.onLine && !this.isSyncing) {
        this.syncNow().catch(() => {});
      }
    };

    window.addEventListener('focus', this._onFocus);
    window.addEventListener('online', this._onOnline);
    document.addEventListener('visibilitychange', this._onVisibility);
  }

  stopAutoSync() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this._onFocus) window.removeEventListener('focus', this._onFocus);
    if (this._onOnline) window.removeEventListener('online', this._onOnline);
    if (this._onVisibility) document.removeEventListener('visibilitychange', this._onVisibility);
  }

  // --- SINCRONIZACIÓN COMPLETA BIDIRECCIONAL CON RECONCILIACIÓN DE ELIMINACIONES ---
  async syncNow(isManual = false) {
    if (!this.config.enabled || this.isSyncing) return;
    if (!navigator.onLine) {
      if (isManual) this.app.pwaManager.showToast('⚠️ Sin conexión a internet para sincronizar');
      return;
    }

    this.isSyncing = true;
    this.updateUIStatus();

    try {
      const code = this.config.householdCode;

      // 1. Procesar eliminaciones pendientes antes de sincronizar
      await this.processPendingDeletes();

      // 2. Asegurar que existe el hogar en la tabla households
      const resHousehold = await fetch(`${this.config.url}/rest/v1/households?on_conflict=id`, {
        method: 'POST',
        headers: this.getHeaders(true),
        body: JSON.stringify([{ id: code, name: this.app.settings?.householdName || 'Hogar Compartido' }])
      });

      if (!resHousehold.ok) {
        if (resHousehold.status === 404) {
          throw new Error('Error 404: Las tablas no existen en Supabase. Debes ejecutar el Script SQL.');
        } else if (resHousehold.status === 401) {
          throw new Error('Error 401: Anon Key inválida o expirada.');
        } else {
          const errData = await resHousehold.json().catch(() => ({}));
          throw new Error(`Error en households (${resHousehold.status}): ${errData.message || resHousehold.statusText}`);
        }
      }

      // 3. DESCARGAR (PULL) ESTADO ACTUAL DE LA NUBE
      const [resMembers, resCategories, resTx] = await Promise.all([
        fetch(`${this.config.url}/rest/v1/members?household_id=eq.${encodeURIComponent(code)}&select=*`, {
          headers: this.getHeaders(false)
        }),
        fetch(`${this.config.url}/rest/v1/categories?household_id=eq.${encodeURIComponent(code)}&select=*`, {
          headers: this.getHeaders(false)
        }),
        fetch(`${this.config.url}/rest/v1/transactions?household_id=eq.${encodeURIComponent(code)}&select=*`, {
          headers: this.getHeaders(false)
        })
      ]);

      if (!resMembers.ok || !resCategories.ok || !resTx.ok) {
        throw new Error('Error al descargar datos de Supabase. Verifica que las tablas existan.');
      }

      const [cloudMembers, cloudCategories, cloudTx] = await Promise.all([
        resMembers.json(),
        resCategories.json(),
        resTx.json()
      ]);

      // 4. RECONCILIACIÓN DE MIEMBROS
      const localMembers = await db.getAll('members');
      if (cloudMembers.length === 0 && localMembers.length > 0) {
        // Inicializar la nube con los miembros locales si estaba completamente vacía
        const payloadMembers = localMembers.map(m => ({
          id: m.id,
          household_id: code,
          name: m.name,
          avatar: m.avatar || '👤',
          color: m.color || '#0284C7',
          is_active: m.isActive !== false,
          updated_at: new Date().toISOString()
        }));
        await fetch(`${this.config.url}/rest/v1/members?on_conflict=id,household_id`, {
          method: 'POST',
          headers: this.getHeaders(true),
          body: JSON.stringify(payloadMembers)
        });
        for (const m of localMembers) {
          m.isNewOffline = false;
          await db.put('members', m);
        }
      } else {
        const cloudMemberIds = new Set(cloudMembers.map(m => m.id));

        // Subir miembros que fueron creados offline en este dispositivo
        const unpushedMembers = localMembers.filter(m => m.isNewOffline && !cloudMemberIds.has(m.id));
        for (const newM of unpushedMembers) {
          await this.pushMember(newM);
          cloudMemberIds.add(newM.id);
        }

        // Eliminar miembros locales que ya NO existen en la nube (fueron borrados en otro teléfono)
        for (const lm of localMembers) {
          if (!cloudMemberIds.has(lm.id) && !lm.isNewOffline) {
            console.log(`[Sync] Miembro "${lm.name}" fue eliminado en la nube, removiendo localmente.`);
            await db.delete('members', lm.id);
          }
        }

        // Guardar o actualizar miembros vigentes de la nube en IndexedDB local
        for (const m of cloudMembers) {
          await db.put('members', {
            id: m.id,
            name: m.name,
            avatar: m.avatar,
            color: m.color,
            isActive: m.is_active,
            createdAt: m.created_at || new Date().toISOString(),
            isNewOffline: false
          });
        }
      }

      // 5. RECONCILIACIÓN DE CATEGORÍAS
      const localCategories = await db.getAll('categories');
      if (cloudCategories.length === 0 && localCategories.length > 0) {
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
        await fetch(`${this.config.url}/rest/v1/categories?on_conflict=id,household_id`, {
          method: 'POST',
          headers: this.getHeaders(true),
          body: JSON.stringify(payloadCategories)
        });
        for (const c of localCategories) {
          c.isNewOffline = false;
          await db.put('categories', c);
        }
      } else {
        const cloudCatIds = new Set(cloudCategories.map(c => c.id));

        // Subir categorías creadas offline
        const unpushedCats = localCategories.filter(c => c.isNewOffline && !cloudCatIds.has(c.id));
        for (const newC of unpushedCats) {
          await this.pushCategory(newC);
          cloudCatIds.add(newC.id);
        }

        // Eliminar categorías locales que fueron borradas en la nube
        for (const lc of localCategories) {
          if (!cloudCatIds.has(lc.id) && !lc.isNewOffline) {
            console.log(`[Sync] Categoría "${lc.name}" fue eliminada en la nube, removiendo localmente.`);
            await db.delete('categories', lc.id);
          }
        }

        // Guardar o actualizar categorías de la nube
        for (const c of cloudCategories) {
          await db.put('categories', {
            id: c.id,
            name: c.name,
            icon: c.icon,
            color: c.color,
            monthlyBudget: Number(c.monthly_budget) || 0,
            isSystem: Boolean(c.is_system),
            isArchived: Boolean(c.is_archived),
            displayOrder: Number(c.display_order) || 0,
            isNewOffline: false
          });
        }
      }

      // 6. RECONCILIACIÓN DE TRANSACCIONES
      const localTransactions = await db.getAll('transactions');
      const cloudTxIds = new Set(cloudTx.map(t => t.id));

      // Subir transacciones creadas offline en este dispositivo
      const unpushedTx = localTransactions.filter(t => t.isNewOffline && !cloudTxIds.has(t.id));
      for (const newTx of unpushedTx) {
        await this.pushTransaction(newTx);
        cloudTxIds.add(newTx.id);
      }

      // Eliminar transacciones locales que fueron eliminadas en la nube
      for (const lt of localTransactions) {
        if (!cloudTxIds.has(lt.id) && !lt.isNewOffline) {
          await db.delete('transactions', lt.id);
        }
      }

      // Guardar o actualizar transacciones de la nube en IndexedDB local
      for (const t of cloudTx) {
        const sanitized = sanitizeTransaction({
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
        });
        sanitized.isNewOffline = false;
        await db.put('transactions', sanitized);
      }

      this.config.lastSyncTime = new Date();
      this.config.lastError = null;
      await this.app.refreshData();
      this.app.renderCurrentView();

      if (isManual) {
        this.app.pwaManager.showToast(`☁️ Sincronizado: ${cloudTx.length} movimientos al día`);
      }
    } catch (err) {
      this.config.lastError = err.message;
      console.warn('[Sync] Error durante la sincronización:', err);
      if (isManual) {
        this.app.pwaManager.showToast(`⚠️ ${err.message}`);
      }
    } finally {
      this.isSyncing = false;
      this.updateUIStatus();
    }
  }

  // --- MÉTODOS DE ENVÍO Y ELIMINACIÓN PUNTUAL ---

  // Envío de miembro creado o modificado
  async pushMember(member) {
    if (!this.config.enabled || !navigator.onLine) return false;
    try {
      const res = await fetch(`${this.config.url}/rest/v1/members?on_conflict=id,household_id`, {
        method: 'POST',
        headers: this.getHeaders(true),
        body: JSON.stringify([{
          id: member.id,
          household_id: this.config.householdCode,
          name: member.name,
          avatar: member.avatar || '👤',
          color: member.color || '#0284C7',
          is_active: member.isActive !== false,
          updated_at: new Date().toISOString()
        }])
      });
      if (res.ok) {
        member.isNewOffline = false;
        await db.put('members', member);
        this.config.lastSyncTime = new Date();
        this.updateUIStatus();
        return true;
      }
      return false;
    } catch (e) {
      console.warn('[Sync] Error al enviar miembro:', e);
      return false;
    }
  }

  // Eliminación definitiva de un miembro en la nube
  async deleteMember(memberId) {
    await this.recordPendingDelete('members', memberId);
    if (!this.config.enabled || !navigator.onLine) return;
    try {
      const res = await fetch(`${this.config.url}/rest/v1/members?id=eq.${encodeURIComponent(memberId)}&household_id=eq.${encodeURIComponent(this.config.householdCode)}`, {
        method: 'DELETE',
        headers: this.getHeaders(false)
      });
      if (res.ok) {
        await this.clearPendingDelete('members', memberId);
        this.config.lastSyncTime = new Date();
        this.updateUIStatus();
      }
    } catch (e) {
      console.warn('[Sync] Error al eliminar miembro en la nube:', e);
    }
  }

  // Envío de categoría creada o modificada
  async pushCategory(category) {
    if (!this.config.enabled || !navigator.onLine) return false;
    try {
      const res = await fetch(`${this.config.url}/rest/v1/categories?on_conflict=id,household_id`, {
        method: 'POST',
        headers: this.getHeaders(true),
        body: JSON.stringify([{
          id: category.id,
          household_id: this.config.householdCode,
          name: category.name,
          icon: category.icon || '📦',
          color: category.color || '#0284C7',
          monthly_budget: category.monthlyBudget || 0,
          is_system: Boolean(category.isSystem),
          is_archived: Boolean(category.isArchived),
          display_order: category.displayOrder || 0,
          updated_at: new Date().toISOString()
        }])
      });
      if (res.ok) {
        category.isNewOffline = false;
        await db.put('categories', category);
        this.config.lastSyncTime = new Date();
        this.updateUIStatus();
        return true;
      }
      return false;
    } catch (e) {
      console.warn('[Sync] Error al enviar categoría:', e);
      return false;
    }
  }

  // Eliminación definitiva de una categoría en la nube
  async deleteCategory(catId) {
    await this.recordPendingDelete('categories', catId);
    if (!this.config.enabled || !navigator.onLine) return;
    try {
      const res = await fetch(`${this.config.url}/rest/v1/categories?id=eq.${encodeURIComponent(catId)}&household_id=eq.${encodeURIComponent(this.config.householdCode)}`, {
        method: 'DELETE',
        headers: this.getHeaders(false)
      });
      if (res.ok) {
        await this.clearPendingDelete('categories', catId);
        this.config.lastSyncTime = new Date();
        this.updateUIStatus();
      }
    } catch (e) {
      console.warn('[Sync] Error al eliminar categoría en la nube:', e);
    }
  }

  // Envío rápido individual de un movimiento recién creado/modificado
  async pushTransaction(tx) {
    if (!this.config.enabled || !navigator.onLine) return false;
    try {
      const res = await fetch(`${this.config.url}/rest/v1/transactions?on_conflict=id,household_id`, {
        method: 'POST',
        headers: this.getHeaders(true),
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

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        console.error('[Sync pushTransaction error]', res.status, errJson);
        this.app.pwaManager.showToast(`⚠️ Error en nube (${res.status}): ${errJson.message || 'No se pudo subir'}`);
        return false;
      }
      tx.isNewOffline = false;
      await db.put('transactions', tx);
      this.config.lastSyncTime = new Date();
      this.config.lastError = null;
      this.updateUIStatus();
      return true;
    } catch (e) {
      console.warn('[Sync] Error al enviar transacción:', e);
      return false;
    }
  }

  // Eliminación definitiva de un movimiento en la nube
  async deleteTransaction(id) {
    await this.recordPendingDelete('transactions', id);
    if (!this.config.enabled || !navigator.onLine) return;
    try {
      const res = await fetch(`${this.config.url}/rest/v1/transactions?id=eq.${encodeURIComponent(id)}&household_id=eq.${encodeURIComponent(this.config.householdCode)}`, {
        method: 'DELETE',
        headers: this.getHeaders(false)
      });
      if (res.ok) {
        await this.clearPendingDelete('transactions', id);
        this.config.lastSyncTime = new Date();
        this.updateUIStatus();
      }
    } catch (e) {
      console.warn('[Sync] Error al eliminar transacción en la nube:', e);
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
    const headerBtn = document.getElementById('btn-header-sync');

    if (!this.config.enabled) {
      if (badge) {
        badge.innerHTML = '⚪ Modo Local (Solo este móvil)';
        badge.style.color = 'var(--ink-secondary)';
        badge.style.background = 'var(--surface-muted)';
        badge.style.borderColor = 'var(--border-color)';
      }
      if (headerBtn) {
        headerBtn.innerHTML = '⚪ Local';
        headerBtn.title = 'Modo Local (Toca para ir a Ajustes y vincular Supabase)';
      }
    } else if (this.isSyncing) {
      if (badge) {
        badge.innerHTML = '🔄 Sincronizando con la nube...';
        badge.style.color = '#0284C7';
        badge.style.background = '#E0F2FE';
        badge.style.borderColor = '#0284C7';
      }
      if (headerBtn) {
        headerBtn.innerHTML = '🔄 Sync...';
      }
    } else if (this.config.lastError) {
      if (badge) {
        badge.innerHTML = `⚠️ <b>Error de Sincronización</b><br><small style="font-weight: normal; font-size: 11px;">${this.config.lastError}</small>`;
        badge.style.color = '#DC2626';
        badge.style.background = '#FEE2E2';
        badge.style.borderColor = '#DC2626';
      }
      if (headerBtn) {
        headerBtn.innerHTML = '⚠️ Error';
        headerBtn.title = `Error: ${this.config.lastError} (Toca para reintentar)`;
      }
    } else {
      const timeStr = this.config.lastSyncTime 
        ? `(${this.config.lastSyncTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })})` 
        : '';
      if (badge) {
        badge.innerHTML = `☁️ Conectado: <b>${this.config.householdCode}</b> ${timeStr}`;
        badge.style.color = '#059669';
        badge.style.background = '#DCFCE7';
        badge.style.borderColor = '#059669';
      }
      if (headerBtn) {
        headerBtn.innerHTML = '☁️ Sinc';
        headerBtn.title = `Conectado a ${this.config.householdCode}. Toca para sincronizar ahora.`;
      }
    }
  }
}
