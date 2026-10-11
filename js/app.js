// Controlador Principal SPA - Control de Gastos del Hogar // Brutal
import { db } from './db.js';
import { 
  SplitTypes, 
  generateId, 
  formatMoney, 
  sanitizeTransaction 
} from './models.js';
import { 
  getISOWeekRange, 
  getMonthRange, 
  getYearRange, 
  filterTransactionsByDate, 
  computePeriodMetrics, 
  calculateHouseholdBalances,
  formatISODate,
  toMoney
} from './split-engine.js';
import { BrutalistChartEngine } from './charts-svg.js';
import { PWAManager } from './pwa-install.js';
import { CloudSyncEngine, SUPABASE_SETUP_SQL } from './sync-engine.js';

class AppController {
  constructor() {
    this.currentTab = 'dashboard';
    this.timePeriod = 'month'; // 'week' | 'month' | 'year'
    this.currentDate = new Date();
    
    this.categories = [];
    this.members = [];
    this.transactions = [];
    this.settings = null;
    
    this.activeMemberId = null;
    this.selectedCatId = null;
    this.selectedSplitType = SplitTypes.SHARED_EQUAL;

    this.chartEngine = null;
    this.pwaManager = null;
    this.syncEngine = new CloudSyncEngine(this);
    this.txFilters = { search: '', categoryId: '', memberId: '', dateFrom: '', dateTo: '' };
  }

  async init() {
    // Inicializar PWA Manager
    this.pwaManager = new PWAManager();
    this.pwaManager.init();

    // Inicializar motor de gráficos
    this.chartEngine = new BrutalistChartEngine('chart-histogram-container', 'touch-projection-card');

    // Cargar datos iniciales
    await this.refreshData();

    // Inicializar motor de sincronización en la nube
    this.syncEngine.init(this.settings);

    // Configurar escuchadores de interfaz
    this.setupNavigation();
    this.setupPeriodControls();
    this.setupQuickAddModal();
    this.setupCategoryModal();
    this.setupMemberModal();
    this.setupSettlementModal();
    this.setupSettingsActions();
    this.setupTransactionFilters();

    // Renderizar vista inicial
    this.renderCurrentView();
  }

  async refreshData() {
    const [categories, members, transactions, settingsList] = await Promise.all([
      db.getAll('categories'),
      db.getAll('members'),
      db.getAll('transactions'),
      db.getAll('settings')
    ]);

    this.categories = categories.sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));
    this.members = members;
    // Transacciones ordenadas descendentemente por fecha y creación
    this.transactions = transactions.sort((a, b) => (b.date.localeCompare(a.date)) || (b.createdAt - a.createdAt));
    this.settings = settingsList[0] || {};
    
    // Asignar miembro activo
    const activeMember = this.members.find(m => m.id === this.settings.activeMemberId && m.isActive) 
      || this.members.find(m => m.isActive) 
      || this.members[0];

    this.activeMemberId = activeMember ? activeMember.id : null;
    this.updateActiveUserBadge();
  }

  // --- NAVEGACIÓN ENTRE SECCIONES ---
  setupNavigation() {
    const navButtons = document.querySelectorAll('.nav-item');
    navButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const targetTab = btn.dataset.tab;
        this.switchTab(targetTab);
      });
    });

    // Selector rápido de usuario en el header
    const userSelectorBtn = document.getElementById('btn-header-user');
    if (userSelectorBtn) {
      userSelectorBtn.addEventListener('click', () => this.cycleActiveUser());
    }

    // Botón de sincronización rápida en el header
    const headerSyncBtn = document.getElementById('btn-header-sync');
    if (headerSyncBtn) {
      headerSyncBtn.addEventListener('click', () => {
        if (!this.syncEngine?.config.enabled) {
          this.switchTab('settings');
          this.pwaManager.showToast('Configura Supabase en Ajustes para activar la sincronización');
        } else {
          this.syncEngine.syncNow(true);
        }
      });
    }
  }

  switchTab(tabName) {
    this.currentTab = tabName;
    document.querySelectorAll('.nav-item').forEach(b => {
      b.classList.toggle('is-active', b.dataset.tab === tabName);
    });

    document.querySelectorAll('.view-section').forEach(sec => {
      sec.classList.toggle('is-active', sec.id === `view-${tabName}`);
    });

    this.renderCurrentView();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  updateActiveUserBadge() {
    const btn = document.getElementById('btn-header-user');
    if (!btn) return;
    const member = this.members.find(m => m.id === this.activeMemberId);
    if (member) {
      btn.innerHTML = `${member.avatar} ${member.name}`;
      btn.style.borderColor = member.color || 'var(--border-color)';
    }
  }

  cycleActiveUser() {
    const activeMembers = this.members.filter(m => m.isActive);
    if (activeMembers.length === 0) return;
    const currentIndex = activeMembers.findIndex(m => m.id === this.activeMemberId);
    const nextMember = activeMembers[(currentIndex + 1) % activeMembers.length];
    this.activeMemberId = nextMember.id;
    this.updateActiveUserBadge();
    this.renderCurrentView();
    this.pwaManager.showToast(`Usuario activo: ${nextMember.name}`);
  }

  // --- CONTROLES TEMPORALES DEL DASHBOARD ---
  setupPeriodControls() {
    const segmentBtns = document.querySelectorAll('.time-segment-btn');
    segmentBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        segmentBtns.forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        this.timePeriod = btn.dataset.period;
        this.renderDashboard();
      });
    });

    const prevBtn = document.getElementById('btn-period-prev');
    const nextBtn = document.getElementById('btn-period-next');

    if (prevBtn) prevBtn.addEventListener('click', () => this.shiftPeriod(-1));
    if (nextBtn) nextBtn.addEventListener('click', () => this.shiftPeriod(1));
  }

  shiftPeriod(direction) {
    if (this.timePeriod === 'week') {
      this.currentDate.setDate(this.currentDate.getDate() + (direction * 7));
    } else if (this.timePeriod === 'month') {
      this.currentDate.setMonth(this.currentDate.getMonth() + direction);
    } else if (this.timePeriod === 'year') {
      this.currentDate.setFullYear(this.currentDate.getFullYear() + direction);
    }
    this.renderDashboard();
  }

  // --- RENDERIZADO SEGÚN VISTA ACTIVA ---
  renderCurrentView() {
    switch (this.currentTab) {
      case 'dashboard':
        this.renderDashboard();
        break;
      case 'transactions':
        this.renderTransactionsView();
        break;
      case 'categories':
        this.renderCategoriesView();
        break;
      case 'members':
        this.renderMembersView();
        break;
      case 'settings':
        this.renderSettingsView();
        break;
    }
  }

  // 1. RENDER DASHBOARD
  renderDashboard() {
    const periodLabel = document.getElementById('period-display-label');
    let startDate, endDate, chartItems = [];

    const categoriesMap = Object.fromEntries(this.categories.map(c => [c.id, c]));
    const membersMap = Object.fromEntries(this.members.map(m => [m.id, m]));

    if (this.timePeriod === 'week') {
      const week = getISOWeekRange(this.currentDate);
      startDate = week.startDate;
      endDate = week.endDate;
      if (periodLabel) periodLabel.textContent = week.label;

      const dayNames = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
      chartItems = week.days.map((isoDay, idx) => {
        const txForDay = this.transactions.filter(t => t.date === isoDay && !t.isSettlement && t.type === 'expense');
        const sum = txForDay.reduce((acc, t) => acc + t.amount, 0);
        return {
          label: dayNames[idx],
          fullDate: isoDay,
          value: sum,
          count: txForDay.length
        };
      });

    } else if (this.timePeriod === 'month') {
      const year = this.currentDate.getFullYear();
      const month = this.currentDate.getMonth();
      const monthData = getMonthRange(year, month);
      startDate = monthData.startDate;
      endDate = monthData.endDate;
      if (periodLabel) periodLabel.textContent = monthData.label.toUpperCase();

      // Agrupar el mes en 4 o 5 segmentos de semanas para una gráfica limpia y legible en móvil
      const totalDays = monthData.totalDays;
      const chunks = [
        { label: 'D 1-7', startDay: 1, endDay: 7 },
        { label: 'D 8-14', startDay: 8, endDay: 14 },
        { label: 'D 15-21', startDay: 15, endDay: 21 },
        { label: 'D 22-28', startDay: 22, endDay: 28 },
        { label: `D 29-${totalDays}`, startDay: 29, endDay: totalDays }
      ];

      chartItems = chunks.map(c => {
        const monthPrefix = `${year}-${String(month + 1).padStart(2, '0')}`;
        const txInChunk = this.transactions.filter(t => {
          if (t.isSettlement || t.type !== 'expense') return false;
          if (!t.date.startsWith(monthPrefix)) return false;
          const dayNum = parseInt(t.date.split('-')[2], 10);
          return dayNum >= c.startDay && dayNum <= c.endDay;
        });
        const sum = txInChunk.reduce((acc, t) => acc + t.amount, 0);
        return {
          label: c.label,
          fullDate: `${monthData.label} (${c.label})`,
          value: sum,
          count: txInChunk.length
        };
      });

    } else if (this.timePeriod === 'year') {
      const year = this.currentDate.getFullYear();
      const yearData = getYearRange(year);
      startDate = yearData.startDate;
      endDate = yearData.endDate;
      if (periodLabel) periodLabel.textContent = yearData.label.toUpperCase();

      const monthShort = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
      chartItems = monthShort.map((label, idx) => {
        const monthPrefix = `${year}-${String(idx + 1).padStart(2, '0')}`;
        const txForMonth = this.transactions.filter(t => t.date.startsWith(monthPrefix) && !t.isSettlement && t.type === 'expense');
        const sum = txForMonth.reduce((acc, t) => acc + t.amount, 0);
        return {
          label,
          fullDate: `${label} ${year}`,
          value: sum,
          count: txForMonth.length
        };
      });
    }

    // Filtrar y calcular métricas
    const periodTransactions = filterTransactionsByDate(this.transactions, startDate, endDate);
    const metrics = computePeriodMetrics(periodTransactions, categoriesMap, membersMap);

    // Actualizar Cajas de Métricas
    const totalEl = document.getElementById('kpi-total-spent');
    const avgEl = document.getElementById('kpi-daily-avg');
    const topCatEl = document.getElementById('kpi-top-category');
    const topSpenderEl = document.getElementById('kpi-top-spender');

    if (totalEl) totalEl.textContent = formatMoney(metrics.totalExpense);

    if (avgEl) {
      let divisor = 1;
      if (this.timePeriod === 'week') divisor = 7;
      else if (this.timePeriod === 'month') divisor = new Date(this.currentDate.getFullYear(), this.currentDate.getMonth() + 1, 0).getDate();
      else if (this.timePeriod === 'year') divisor = 365;
      const dailyAvg = metrics.totalExpense / divisor;
      avgEl.textContent = formatMoney(dailyAvg);
    }

    if (topCatEl) {
      topCatEl.textContent = metrics.topCategory ? `${metrics.topCategory.icon} ${metrics.topCategory.name}` : 'Ninguna';
    }

    if (topSpenderEl) {
      topSpenderEl.textContent = metrics.topSpender ? `${metrics.topSpender.avatar || '👤'} ${metrics.topSpender.name}` : 'N/A';
    }

    // Renderizar Histograma SVG
    this.chartEngine.renderHistogram(chartItems);

    // Renderizar Desglose por Categorías
    this.renderCategoryBreakdown(metrics.categoryBreakdown);

    // Resumen de Deudas del Hogar en Dashboard
    this.renderDashboardDebts();
  }

  renderCategoryBreakdown(breakdown = []) {
    const container = document.getElementById('dashboard-categories-breakdown');
    if (!container) return;

    if (breakdown.length === 0) {
      container.innerHTML = `
        <div style="font-family: var(--font-mono); font-size: 11px; text-align: center; color: var(--ink-secondary); padding: 8px;">
          Sin gastos en este periodo
        </div>
      `;
      return;
    }

    container.innerHTML = breakdown.slice(0, 6).map(item => `
      <div class="cat-progress-item">
        <div class="cat-progress-header">
          <span>${item.icon} ${item.name}</span>
          <span style="font-family: var(--font-mono); font-weight: 800;">
            ${formatMoney(item.amount)} (${item.percentage}%)
          </span>
        </div>
        <div class="cat-progress-bar-bg">
          <div class="cat-progress-fill" style="width: ${item.percentage}%; background-color: ${item.color || 'var(--navy-secondary)'};"></div>
        </div>
      </div>
    `).join('');
  }

  renderDashboardDebts() {
    const container = document.getElementById('dashboard-debts-summary');
    if (!container) return;

    const activeMembers = this.members.filter(m => m.isActive);
    const settlements = calculateHouseholdBalances(this.transactions, activeMembers);

    if (settlements.length === 0) {
      container.innerHTML = `
        <div style="font-family: var(--font-mono); font-size: 11px; font-weight: 700; color: var(--emerald-income); background: var(--emerald-bg); padding: 8px; border: var(--border-solid);">
          ✓ ¡Cuentas al día! Nadie debe nada en el hogar.
        </div>
      `;
      return;
    }

    container.innerHTML = settlements.map(s => `
      <div style="display: flex; align-items: center; justify-content: space-between; padding: 6px 8px; background: var(--surface-card); border: var(--border-solid); margin-bottom: 6px; box-shadow: 1px 1px 0px #000;">
        <span style="font-size: 12px; font-weight: 700;">
          ${s.debtorAvatar} <b>${s.debtorName}</b> debe transferir a ${s.creditorAvatar} <b>${s.creditorName}</b>
        </span>
        <span style="font-family: var(--font-mono); font-weight: 900; color: var(--coral-expense); font-size: 13px;">
          ${s.formattedAmount}
        </span>
      </div>
    `).join('') + `
      <button class="b-btn btn-emerald" id="btn-quick-settle-dash" style="margin-top: 6px; padding: 8px;">
        ⚡ SALDAR CUENTAS AHORA
      </button>
    `;

    const btnQuickSettle = document.getElementById('btn-quick-settle-dash');
    if (btnQuickSettle) {
      btnQuickSettle.addEventListener('click', () => {
        this.switchTab('members');
      });
    }
  }

  // --- FILTROS Y BUSCADOR DE GASTOS ---
  setupTransactionFilters() {
    const bind = (id, key, evt = 'input') => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener(evt, () => {
        this.txFilters[key] = el.value;
        this.renderTransactionsView();
      });
    };
    bind('tx-search', 'search');
    bind('tx-filter-category', 'categoryId', 'change');
    bind('tx-filter-member', 'memberId', 'change');
    bind('tx-filter-from', 'dateFrom', 'change');
    bind('tx-filter-to', 'dateTo', 'change');

    const clearBtn = document.getElementById('btn-clear-tx-filters');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        this.txFilters = { search: '', categoryId: '', memberId: '', dateFrom: '', dateTo: '' };
        ['tx-search', 'tx-filter-category', 'tx-filter-member', 'tx-filter-from', 'tx-filter-to']
          .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
        this.renderTransactionsView();
      });
    }

    // Filtros rápidos por periodo (tocar de nuevo el chip activo lo desactiva)
    document.querySelectorAll('.tx-quick-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const range = this.getQuickRange(chip.dataset.quick);
        const isActive = this.txFilters.dateFrom === range.from && this.txFilters.dateTo === range.to;
        this.txFilters.dateFrom = isActive ? '' : range.from;
        this.txFilters.dateTo = isActive ? '' : range.to;
        const fromEl = document.getElementById('tx-filter-from');
        const toEl = document.getElementById('tx-filter-to');
        if (fromEl) fromEl.value = this.txFilters.dateFrom;
        if (toEl) toEl.value = this.txFilters.dateTo;
        this.renderTransactionsView();
      });
    });
  }

  // Devuelve { from, to } en formato YYYY-MM-DD para cada filtro rápido
  getQuickRange(kind) {
    const now = new Date();
    if (kind === 'week') {
      const w = getISOWeekRange(now); // Lunes a Domingo (ISO-8601)
      return { from: w.startDate, to: w.endDate };
    }
    if (kind === 'lastMonth') {
      // new Date(año, mes - 1, 1) resuelve bien el cambio de año (enero -> diciembre)
      const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const m = getMonthRange(prev.getFullYear(), prev.getMonth());
      return { from: m.startDate, to: m.endDate };
    }
    const m = getMonthRange(now.getFullYear(), now.getMonth());
    return { from: m.startDate, to: m.endDate };
  }

  // Resalta el chip cuyo rango coincide exactamente con las fechas elegidas
  updateQuickChipsState() {
    document.querySelectorAll('.tx-quick-chip').forEach(chip => {
      const range = this.getQuickRange(chip.dataset.quick);
      const active = this.txFilters.dateFrom === range.from && this.txFilters.dateTo === range.to;
      chip.classList.toggle('is-active', active);
      chip.setAttribute('aria-pressed', String(active));
    });
  }

  // Rellena los selects con categorías y miembros actuales, conservando la selección
  populateTxFilterOptions() {
    const catSel = document.getElementById('tx-filter-category');
    const memSel = document.getElementById('tx-filter-member');
    if (catSel) {
      catSel.innerHTML = '<option value="">Todas las categorías</option>' +
        this.categories.map(c => `<option value="${c.id}">${c.icon} ${c.name}</option>`).join('');
      catSel.value = this.txFilters.categoryId;
    }
    if (memSel) {
      memSel.innerHTML = '<option value="">Todos los usuarios</option>' +
        this.members.map(m => `<option value="${m.id}">${m.avatar} ${m.name}${m.isActive ? '' : ' (inactivo)'}</option>`).join('');
      memSel.value = this.txFilters.memberId;
    }
  }

  updateTxSummary(count, total, settlements = 0) {
    const summary = document.getElementById('tx-results-summary');
    if (summary) summary.textContent = `${count} resultado${count === 1 ? '' : 's'}`;

    const totalEl = document.getElementById('tx-total-value');
    if (totalEl) totalEl.textContent = formatMoney(total);

    const countEl = document.getElementById('tx-total-count');
    if (countEl) {
      const expenses = count - settlements;
      const base = `${expenses} gasto${expenses === 1 ? '' : 's'}`;
      countEl.textContent = settlements > 0
        ? `${base} · ${settlements} liquidación${settlements === 1 ? '' : 'es'} no suma${settlements === 1 ? '' : 'n'}`
        : base;
    }
  }

  // 2. RENDER TRANSACCIONES
  renderTransactionsView() {
    const listEl = document.getElementById('transactions-full-list');
    if (!listEl) return;

    const categoriesMap = Object.fromEntries(this.categories.map(c => [c.id, c]));
    const membersMap = Object.fromEntries(this.members.map(m => [m.id, m]));

    this.populateTxFilterOptions();
    this.updateQuickChipsState();

    if (this.transactions.length === 0) {
      this.updateTxSummary(0, 0);
      listEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">💸</div>
          <div class="empty-state-text">No hay movimientos registrados en la casa.</div>
          <button class="b-btn btn-coral" id="btn-empty-add-tx" style="max-width: 240px; margin: 0 auto;">
            + REGISTRAR PRIMER GASTO
          </button>
        </div>
      `;
      const btnAdd = document.getElementById('btn-empty-add-tx');
      if (btnAdd) btnAdd.onclick = () => this.openQuickAddModal();
      return;
    }

    const f = this.txFilters;
    const query = f.search.trim().toLowerCase();
    const filtered = this.transactions.filter(tx => {
      if (f.categoryId && tx.categoryId !== f.categoryId) return false;
      if (f.memberId && tx.paidByMemberId !== f.memberId) return false;
      if (f.dateFrom && tx.date < f.dateFrom) return false;
      if (f.dateTo && tx.date > f.dateTo) return false;
      if (query) {
        const cat = categoriesMap[tx.categoryId];
        const payer = membersMap[tx.paidByMemberId];
        const haystack = [tx.note, cat && cat.name, payer && payer.name]
          .filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });

    const totalCents = filtered
      .filter(tx => !tx.isSettlement && tx.type === 'expense')
      .reduce((acc, tx) => acc + Math.round(tx.amount * 100), 0);
    const settlementsCount = filtered.filter(tx => tx.isSettlement).length;
    this.updateTxSummary(filtered.length, totalCents / 100, settlementsCount);

    if (filtered.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🔍</div>
          <div class="empty-state-text">Ningún movimiento coincide con los filtros.</div>
        </div>
      `;
      return;
    }

    listEl.innerHTML = filtered.map(tx => {
      const cat = categoriesMap[tx.categoryId] || { name: 'Sin categoría', icon: '📦' };
      const payer = membersMap[tx.paidByMemberId] || { name: 'Alguien', avatar: '👤' };

      const splitLabel = tx.isSettlement 
        ? 'LIQUIDACIÓN' 
        : (tx.splitType === SplitTypes.SHARED_EQUAL ? '50/50 CASA' : (tx.splitType === SplitTypes.PERSONAL ? 'PERSONAL' : 'DIRECTO'));

      return `
        <div class="tx-item ${tx.isSettlement ? 'is-settlement' : ''}" data-id="${tx.id}">
          <div class="tx-left">
            <div class="tx-icon-badge">${tx.isSettlement ? '🤝' : cat.icon}</div>
            <div class="tx-info">
              <div class="tx-title">${tx.note || cat.name}</div>
              <div class="tx-meta">
                <span>${tx.date}</span>
                <span class="tx-member-tag">${payer.avatar} ${payer.name}</span>
                <span class="tx-split-tag">${splitLabel}</span>
              </div>
            </div>
          </div>
          <div class="tx-right">
            <span class="tx-amount">${tx.isSettlement ? '+' : '-'}${formatMoney(tx.amount)}</span>
          </div>
        </div>
      `;
    }).join('');

    // Click en transacción para opciones (Eliminar)
    listEl.querySelectorAll('.tx-item').forEach(item => {
      item.onclick = () => {
        const id = item.dataset.id;
        const tx = this.transactions.find(t => t.id === id);
        if (!tx) return;
        const confirmDelete = confirm(`¿Deseas eliminar el movimiento "${tx.note || 'Gasto'}" por ${formatMoney(tx.amount)}?`);
        if (confirmDelete) {
          this.deleteTransaction(id);
        }
      };
    });
  }

  async deleteTransaction(id) {
    await db.delete('transactions', id);
    if (this.syncEngine?.config.enabled) {
      this.syncEngine.deleteTransaction(id);
    }
    await this.refreshData();
    this.renderCurrentView();
    this.pwaManager.showToast('Gasto eliminado');
  }

  // 3. RENDER CATEGORÍAS
  renderCategoriesView() {
    const grid = document.getElementById('categories-grid-container');
    if (!grid) return;

    grid.innerHTML = this.categories.map(cat => `
      <div class="category-card" data-id="${cat.id}">
        <div class="cat-top">
          <div class="cat-emoji" style="border-color: ${cat.color || 'var(--navy-deep)'};">${cat.icon}</div>
          <span style="font-family: var(--font-mono); font-size: 9px; font-weight: 800; color: ${cat.isSystem ? 'var(--navy-secondary)' : 'var(--cyan-active)'};">
            ${cat.isSystem ? 'SISTEMA' : 'CUSTOM'}
          </span>
        </div>
        <div class="cat-name">${cat.name}</div>
        <div class="cat-budget">Límite: ${formatMoney(cat.monthlyBudget || 0)}</div>
        <div class="cat-actions">
          <button class="btn-action-icon btn-edit-cat" data-id="${cat.id}">EDITAR</button>
          ${!cat.isSystem ? `<button class="btn-action-icon btn-delete-cat" data-id="${cat.id}" style="color: var(--coral-expense);">BORRAR</button>` : ''}
        </div>
      </div>
    `).join('') + `
      <div class="category-card" id="btn-add-new-category" style="border-style: dashed; cursor: pointer; align-items: center; justify-content: center; text-align: center;">
        <div style="font-size: 24px; font-weight: 900; color: var(--navy-secondary);">+</div>
        <div style="font-family: var(--font-mono); font-size: 11px; font-weight: 800;">NUEVA CATEGORÍA</div>
      </div>
    `;

    // Botón nueva categoría
    const btnNew = document.getElementById('btn-add-new-category');
    if (btnNew) btnNew.onclick = () => this.openCategoryModal();

    // Botones editar
    grid.querySelectorAll('.btn-edit-cat').forEach(b => {
      b.onclick = (e) => {
        e.stopPropagation();
        const cat = this.categories.find(c => c.id === b.dataset.id);
        if (cat) this.openCategoryModal(cat);
      };
    });

    // Botones borrar
    grid.querySelectorAll('.btn-delete-cat').forEach(b => {
      b.onclick = (e) => {
        e.stopPropagation();
        this.handleDeleteCategory(b.dataset.id);
      };
    });
  }

  async handleDeleteCategory(catId) {
    const cat = this.categories.find(c => c.id === catId);
    if (!cat || cat.isSystem) return;

    // Verificar si hay transacciones asociadas
    const associatedTx = this.transactions.filter(t => t.categoryId === catId);
    if (associatedTx.length > 0) {
      // Wizard de reasignación en 1 paso
      const remainingCats = this.categories.filter(c => c.id !== catId);
      const catOptions = remainingCats.map(c => `• ${c.name}`).join('\n');
      const targetName = prompt(
        `Esta categoría tiene ${associatedTx.length} gasto(s) registrado(s).\n\nPara no romper tu historial financiero, indica el nombre exacto de la categoría a donde deseas reasignarlos:\n\n${catOptions}`,
        remainingCats[0]?.name || ''
      );

      if (!targetName) return;
      const targetCat = remainingCats.find(c => c.name.toLowerCase() === targetName.trim().toLowerCase());
      if (!targetCat) {
        alert('Categoría no encontrada. Operación cancelada para proteger tus datos.');
        return;
      }

      // Reasignar transacciones atómicamente
      for (const tx of associatedTx) {
        tx.categoryId = targetCat.id;
        await db.put('transactions', tx);
      }
    }

    // Eliminar la categoría
    await db.delete('categories', catId);
    await this.refreshData();
    this.renderCurrentView();
    this.pwaManager.showToast('Categoría eliminada y gastos reasignados');
  }

  // 4. RENDER MIEMBROS & SALDOS
  renderMembersView() {
    const container = document.getElementById('members-view-container');
    if (!container) return;

    const activeMembers = this.members.filter(m => m.isActive);
    const settlements = calculateHouseholdBalances(this.transactions, activeMembers);

    container.innerHTML = `
      <div class="b-card">
        <div class="b-card-header">
          <div class="b-card-title">👥 MIEMBROS DEL HOGAR</div>
          <button class="b-btn btn-secondary" id="btn-open-member-modal" style="width: auto; padding: 4px 8px; font-size: 10px;">
            + AÑADIR
          </button>
        </div>
        <div style="display: flex; flex-direction: column; gap: 8px;">
          ${this.members.map(m => `
            <div style="display: flex; align-items: center; justify-content: space-between; padding: 10px; border: var(--border-solid); background: var(--surface-card); box-shadow: 1px 1px 0px #000; border-radius: var(--radius-micro); gap: 8px; flex-wrap: wrap;">
              <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
                <span style="font-size: 24px; border: 2px solid ${m.color || 'var(--navy-deep)'}; border-radius: 50%; width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; background: var(--surface-muted); flex-shrink: 0;">${m.avatar}</span>
                <div style="min-width: 0;">
                  <div style="font-weight: 800; font-size: 14px; display: flex; align-items: center; gap: 6px;">
                    <span>${m.name}</span>
                    ${!m.isActive ? '<span style="font-size: 10px; color: var(--coral-expense); font-weight: 700;">(Inactivo)</span>' : ''}
                  </div>
                  <div style="font-family: var(--font-mono); font-size: 10px; color: var(--ink-secondary);">
                    ${m.id === this.activeMemberId ? '★ Usuario Activo en este móvil' : ''}
                  </div>
                </div>
              </div>
              <div style="display: flex; gap: 4px; align-items: center; flex-wrap: wrap;">
                <button class="btn-action-icon btn-edit-member" data-id="${m.id}">EDITAR</button>
                <button class="btn-action-icon btn-toggle-member" data-id="${m.id}">
                  ${m.isActive ? 'DESACTIVAR' : 'ACTIVAR'}
                </button>
                <button class="btn-action-icon btn-delete-member" data-id="${m.id}" style="color: var(--coral-expense);">
                  BORRAR
                </button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="b-card">
        <div class="b-card-header">
          <div class="b-card-title">⚖️ MATRIZ DE DEUDAS Y LIQUIDACIÓN</div>
        </div>
        ${settlements.length === 0 ? `
          <div style="font-family: var(--font-mono); font-size: 12px; font-weight: 800; color: var(--emerald-income); background: var(--emerald-bg); padding: 12px; border: var(--border-solid); text-align: center;">
            ✓ TODOS LOS MIEMBROS ESTÁN A MANO (SALDO $ 0.00)
          </div>
        ` : `
          <div class="balances-container">
            ${settlements.map((s, idx) => `
              <div class="debt-card">
                <div class="debt-header">
                  <span>${s.debtorAvatar} ${s.debtorName} ➔ ${s.creditorAvatar} ${s.creditorName}</span>
                  <span style="color: var(--coral-expense);">${s.formattedAmount}</span>
                </div>
                <div class="debt-detail">
                  Para equilibrar los aportes de los gastos compartidos del hogar.
                </div>
                <button class="btn-settle btn-settle-debt" data-idx="${idx}">
                  🤝 SALDAR ESTA DEUDA (${s.formattedAmount})
                </button>
              </div>
            `).join('')}
          </div>
        `}
      </div>
    `;

    // Vincular botón nuevo miembro
    const btnNewMem = document.getElementById('btn-open-member-modal');
    if (btnNewMem) btnNewMem.onclick = () => this.openMemberModal();

    // Vincular editar miembro
    container.querySelectorAll('.btn-edit-member').forEach(b => {
      b.onclick = () => {
        const mem = this.members.find(m => m.id === b.dataset.id);
        if (mem) this.openMemberModal(mem);
      };
    });

    // Vincular toggle miembro
    container.querySelectorAll('.btn-toggle-member').forEach(b => {
      b.onclick = async () => {
        const mem = this.members.find(m => m.id === b.dataset.id);
        if (mem) {
          mem.isActive = !mem.isActive;
          await db.put('members', mem);
          await this.refreshData();
          this.renderMembersView();
          this.pwaManager.showToast(`Estado de ${mem.name} actualizado`);
        }
      };
    });

    // Vincular borrar miembro
    container.querySelectorAll('.btn-delete-member').forEach(b => {
      b.onclick = () => {
        this.handleDeleteMember(b.dataset.id);
      };
    });

    // Vincular botones de saldar deuda
    container.querySelectorAll('.btn-settle-debt').forEach(b => {
      b.onclick = () => {
        const s = settlements[Number(b.dataset.idx)];
        if (s) this.openSettlementModal(s);
      };
    });
  }

  async handleDeleteMember(memberId) {
    const member = this.members.find(m => m.id === memberId);
    if (!member) return;

    if (this.members.length <= 1) {
      alert('No puedes eliminar al único miembro del hogar. Siempre debe existir al menos un miembro.');
      return;
    }

    // Verificar si el miembro tiene gastos asociados
    const associatedTx = this.transactions.filter(t => 
      t.paidByMemberId === memberId || 
      (Array.isArray(t.beneficiaryMemberIds) && t.beneficiaryMemberIds.includes(memberId))
    );

    if (associatedTx.length > 0) {
      const remainingMembers = this.members.filter(m => m.id !== memberId);
      const memberOptions = remainingMembers.map(m => `• ${m.name}`).join('\n');

      const targetName = prompt(
        `El miembro "${member.name}" tiene ${associatedTx.length} gasto(s) o registros asociados.\n\n` +
        `Para no romper tu historial financiero, indica el nombre exacto del miembro al que deseas reasignar sus gastos:\n\n${memberOptions}`,
        remainingMembers[0]?.name || ''
      );

      if (!targetName) return;

      const targetMember = remainingMembers.find(m => m.name.toLowerCase() === targetName.trim().toLowerCase());
      if (!targetMember) {
        alert('Miembro no encontrado. Operación cancelada para proteger tus datos.');
        return;
      }

      // Reasignar transacciones
      for (const tx of associatedTx) {
        if (tx.paidByMemberId === memberId) {
          tx.paidByMemberId = targetMember.id;
        }
        if (Array.isArray(tx.beneficiaryMemberIds) && tx.beneficiaryMemberIds.includes(memberId)) {
          tx.beneficiaryMemberIds = tx.beneficiaryMemberIds.map(id => id === memberId ? targetMember.id : id);
        }
        await db.put('transactions', tx);
      }
    } else {
      const confirmDelete = confirm(`¿Estás seguro de que deseas eliminar permanentemente a "${member.name}"?`);
      if (!confirmDelete) return;
    }

    // Si era el usuario activo, cambiar a otro miembro
    if (this.activeMemberId === memberId) {
      const nextMember = this.members.find(m => m.id !== memberId);
      this.activeMemberId = nextMember ? nextMember.id : null;
      if (this.settings) {
        this.settings.activeMemberId = this.activeMemberId;
        await db.put('settings', this.settings);
      }
    }

    await db.delete('members', memberId);
    await this.refreshData();
    this.renderMembersView();
    this.pwaManager.showToast(`Miembro "${member.name}" eliminado correctamente`);
  }

  // 5. RENDER AJUSTES
  renderSettingsView() {
    const container = document.getElementById('settings-view-container');
    if (!container) return;

    const syncConfig = this.syncEngine?.config || {};

    container.innerHTML = `
      <div class="b-card">
        <div class="b-card-header">
          <div class="b-card-title">☁️ SINCRONIZACIÓN EN LA NUBE (MULTI-MÓVIL)</div>
        </div>
        <div id="sync-status-badge" style="margin-bottom: 12px; padding: 10px 14px; border-radius: var(--radius-micro); font-size: 12px; font-weight: 700; text-align: center; border: var(--border-solid);">
          <!-- Actualizado por syncEngine -->
        </div>
        <div id="sync-diagnostic-result" style="display: none; padding: 10px 14px; border-radius: var(--radius-micro); font-size: 12px; margin-bottom: 12px; border: var(--border-solid); line-height: 1.4;">
        </div>
        <p style="font-size: 12px; color: var(--ink-secondary); margin-bottom: 12px; line-height: 1.5;">
          Conecta una base de datos gratuita de <b>Supabase</b> para que todos los teléfonos del hogar compartan y sincronicen sus gastos en tiempo real.
        </p>

        <div class="form-group">
          <label class="form-label">Código del Hogar (Sala compartida):</label>
          <input type="text" class="form-input" id="setting-sync-code" placeholder="Ej. CASA-FAMILIA" value="${syncConfig.householdCode || ''}">
        </div>

        <div class="form-group">
          <label class="form-label">Supabase Project URL:</label>
          <input type="url" class="form-input" id="setting-sync-url" placeholder="https://xyzcompany.supabase.co" value="${syncConfig.url || ''}">
        </div>

        <div class="form-group">
          <label class="form-label">Supabase Anon Public Key:</label>
          <input type="password" class="form-input" id="setting-sync-key" placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." value="${syncConfig.anonKey || ''}">
        </div>

        <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 10px;">
          <button class="b-btn" id="btn-test-sync" style="background: #F1F5F9; border-color: #0284C7; color: #0284C7; font-weight: 800;">🔍 PROBAR Y VERIFICAR CONEXIÓN</button>
          <button class="b-btn btn-emerald" id="btn-save-sync">☁️ GUARDAR Y ACTIVAR SINCRONIZACIÓN</button>
          ${syncConfig.enabled ? '<button class="b-btn" id="btn-force-sync" style="background: #E0F2FE; color: #0369A1; border-color: #0284C7;">🔄 FORZAR ACTUALIZACIÓN AHORA</button>' : ''}
          <button class="b-btn" id="btn-share-sync" style="background: var(--cyan-active);">🔗 COPIAR ENLACE PARA OTROS MÓVILES (1 CLIC)</button>
          <button class="b-btn btn-secondary" id="btn-copy-sql">📜 COPIAR SCRIPT SQL PARA SUPABASE</button>
          ${syncConfig.enabled ? '<button class="b-btn btn-coral" id="btn-disconnect-sync">✕ DESCONECTAR DE LA NUBE</button>' : ''}
        </div>
      </div>

      <div class="b-card">
        <div class="b-card-header">
          <div class="b-card-title">⚙️ INFORMACIÓN DEL HOGAR</div>
        </div>
        <div class="form-group">
          <label class="form-label">Nombre del Hogar</label>
          <input type="text" class="form-input" id="setting-household-name" value="${this.settings?.householdName || 'Hogar Compartido'}">
        </div>
        <div class="form-group">
          <label class="form-label">Moneda Principal</label>
          <input type="text" class="form-input" id="setting-currency-symbol" value="${this.settings?.currencySymbol || '$'}" maxlength="4">
        </div>
        <button class="b-btn" id="btn-save-settings" style="margin-top: 8px;">GUARDAR CAMBIOS</button>
      </div>

      <div class="b-card">
        <div class="b-card-header">
          <div class="b-card-title">💾 COPIAS DE SEGURIDAD Y RESPALDOS</div>
        </div>
        <p style="font-size: 11px; color: var(--ink-secondary); margin-bottom: 10px;">
          Tus datos se guardan de forma local en tu teléfono. Descarga una copia de respaldo para transferir a otro móvil o abrir en Excel.
        </p>
        <div style="display: flex; flex-direction: column; gap: 8px;">
          <button class="b-btn" id="btn-export-json">💾 DESCARGAR COPIA COMPLETA (.JSON)</button>
          <button class="b-btn btn-secondary" id="btn-export-csv">📄 EXPORTAR A HOJA DE CÁLCULO (.CSV)</button>
          <button class="b-btn btn-secondary" id="btn-import-json">📂 RESTAURAR DESDE ARCHIVO (.JSON)</button>
          <input type="file" id="file-import-input" accept=".json" style="display: none;">
        </div>
      </div>

      <div class="b-card">
        <div class="b-card-header">
          <div class="b-card-title">🛠️ PRUEBAS Y MANTENIMIENTO</div>
        </div>
        <div style="display: flex; flex-direction: column; gap: 8px;">
          <button class="b-btn btn-emerald" id="btn-load-demo-data">🎲 CARGAR DATOS DEMO REALISTAS</button>
          <button class="b-btn btn-coral" id="btn-reset-transactions">🗑️ PURGAR TODAS LAS TRANSACCIONES</button>
        </div>
      </div>
    `;

    // Actualizar estado del badge de sync
    this.syncEngine?.updateUIStatus();

    // Botón de prueba y diagnóstico de conexión
    const btnTestSync = document.getElementById('btn-test-sync');
    if (btnTestSync) {
      btnTestSync.onclick = async () => {
        const code = document.getElementById('setting-sync-code')?.value.trim().toUpperCase();
        const url = document.getElementById('setting-sync-url')?.value.trim().replace(/\/+$/, '');
        const key = document.getElementById('setting-sync-key')?.value.trim();
        const diagBox = document.getElementById('sync-diagnostic-result');

        if (diagBox) {
          diagBox.style.display = 'block';
          diagBox.style.background = '#EFF6FF';
          diagBox.style.color = '#1D4ED8';
          diagBox.style.borderColor = '#3B82F6';
          diagBox.innerHTML = '⏳ <b>Verificando conexión y tablas en Supabase...</b><br>Comprobando endpoint, claves y permisos.';
        }

        const result = await this.syncEngine.testConnection(url, key, code);

        if (diagBox) {
          if (result.ok) {
            diagBox.style.background = '#DCFCE7';
            diagBox.style.color = '#15803D';
            diagBox.style.borderColor = '#16A34A';
            diagBox.innerHTML = `✅ <b>Verificación Exitosa:</b><br>${result.message}`;
          } else {
            diagBox.style.background = '#FEE2E2';
            diagBox.style.color = '#B91C1C';
            diagBox.style.borderColor = '#DC2626';
            diagBox.innerHTML = `❌ <b>Problema Detectado (${result.status}):</b><br>${result.message}`;
          }
        }
      };
    }

    // Forzar sincronización manual
    const btnForceSync = document.getElementById('btn-force-sync');
    if (btnForceSync) {
      btnForceSync.onclick = async () => {
        await this.syncEngine.syncNow(true);
      };
    }

    // Guardar configuración de sync
    const btnSaveSync = document.getElementById('btn-save-sync');
    if (btnSaveSync) {
      btnSaveSync.onclick = async () => {
        const code = document.getElementById('setting-sync-code')?.value.trim().toUpperCase();
        const url = document.getElementById('setting-sync-url')?.value.trim().replace(/\/+$/, '');
        const key = document.getElementById('setting-sync-key')?.value.trim();

        if (!code || !url || !key) {
          alert('Por favor completa el Código del Hogar, la URL y la Anon Key de Supabase.');
          return;
        }

        this.syncEngine.config.householdCode = code;
        this.syncEngine.config.url = url;
        this.syncEngine.config.anonKey = key;
        this.syncEngine.config.enabled = true;

        await this.syncEngine.saveConfigToSettings();
        this.syncEngine.startAutoSync();
        this.pwaManager.showToast('Configuración guardada. Sincronizando...');
        await this.syncEngine.syncNow(true);
        this.renderSettingsView();
      };
    }

    // Copiar enlace de invitación para otros móviles
    const btnShareSync = document.getElementById('btn-share-sync');
    if (btnShareSync) {
      btnShareSync.onclick = async () => {
        if (!this.syncEngine?.config.enabled) {
          alert('Primero debes guardar la URL, Clave y Código de Hogar antes de generar el enlace de invitación.');
          return;
        }
        const link = this.syncEngine.generateShareableLink();
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(link);
            alert('¡Enlace de invitación copiado al portapapeles!\n\nEnvíalo por WhatsApp o mensaje al otro móvil. Al abrirlo, se configurará automáticamente en 1 solo clic.');
          } else {
            prompt('Copia este enlace y ábrelo en el otro móvil para sincronizarlo automáticamente:', link);
          }
        } catch (e) {
          prompt('Copia este enlace y ábrelo en el otro móvil:', link);
        }
      };
    }

    // Copiar script SQL
    const btnCopySql = document.getElementById('btn-copy-sql');
    if (btnCopySql) {
      btnCopySql.onclick = async () => {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(SUPABASE_SETUP_SQL);
            alert('¡Script SQL copiado al portapapeles!\n\nPégalo en el SQL Editor de tu proyecto en Supabase (supabase.com) y pulsa Run.');
          } else {
            prompt('Copia este SQL para ejecutarlo en Supabase:', SUPABASE_SETUP_SQL);
          }
        } catch (e) {
          prompt('Copia este SQL para ejecutarlo en Supabase:', SUPABASE_SETUP_SQL);
        }
      };
    }

    // Desconectar sync
    const btnDisconnectSync = document.getElementById('btn-disconnect-sync');
    if (btnDisconnectSync) {
      btnDisconnectSync.onclick = async () => {
        const confirmDisc = confirm('¿Deseas desconectar este móvil de la nube y volver al modo solo local?');
        if (!confirmDisc) return;
        this.syncEngine.config.enabled = false;
        this.syncEngine.config.url = '';
        this.syncEngine.config.anonKey = '';
        this.syncEngine.config.householdCode = '';
        this.syncEngine.stopAutoSync();
        await this.syncEngine.saveConfigToSettings();
        this.pwaManager.showToast('Desconectado de la nube');
        this.renderSettingsView();
      };
    }

    // Re-vincular botones de backup
    this.pwaManager.setupExportImportHandlers();

    // Guardar ajustes generales
    const btnSave = document.getElementById('btn-save-settings');
    if (btnSave) {
      btnSave.onclick = async () => {
        const name = document.getElementById('setting-household-name').value;
        const cur = document.getElementById('setting-currency-symbol').value;
        this.settings.householdName = name;
        this.settings.currencySymbol = cur;
        await db.put('settings', this.settings);
        this.pwaManager.showToast('Configuración guardada');
      };
    }

    // Demo Data
    const btnDemo = document.getElementById('btn-load-demo-data');
    if (btnDemo) {
      btnDemo.onclick = async () => {
        await db.loadDemoData();
        await this.refreshData();
        this.syncEngine?.syncNow().catch(() => {});
        this.pwaManager.showToast('12 gastos de prueba inyectados');
        this.switchTab('dashboard');
      };
    }

    // Reset Data
    const btnReset = document.getElementById('btn-reset-transactions');
    if (btnReset) {
      btnReset.onclick = async () => {
        const confirmPurge = confirm('¿Confirmas purgar todos los movimientos de gastos? Esta acción no se puede deshacer.');
        if (confirmPurge) {
          await db.resetTransactions();
          await this.refreshData();
          this.pwaManager.showToast('Base de datos vaciada');
          this.switchTab('dashboard');
        }
      };
    }
  }

  // --- MODAL DE REGISTRO RÁPIDO (< 3 SEGUNDOS) ---
  setupQuickAddModal() {
    const fab = document.getElementById('fab-quick-add');
    const modal = document.getElementById('modal-quick-add');
    const closeBtn = document.getElementById('btn-close-quick-add');
    const amountInput = document.getElementById('quick-add-amount');
    const form = document.getElementById('form-quick-add');

    if (fab) fab.onclick = () => this.openQuickAddModal();
    if (closeBtn) closeBtn.onclick = () => this.closeQuickAddModal();

    if (modal) {
      modal.onclick = (e) => {
        if (e.target === modal) this.closeQuickAddModal();
      };
    }

    // Chips de categoría
    const chipsContainer = document.getElementById('quick-add-category-chips');
    if (chipsContainer) {
      chipsContainer.addEventListener('click', (e) => {
        const chip = e.target.closest('.category-chip-btn');
        if (!chip) return;
        chipsContainer.querySelectorAll('.category-chip-btn').forEach(c => c.classList.remove('is-selected'));
        chip.classList.add('is-selected');
        this.selectedCatId = chip.dataset.id;
      });
    }

    // Selector de reparto
    const splitBtns = document.querySelectorAll('.split-option-btn');
    splitBtns.forEach(b => {
      b.onclick = () => {
        splitBtns.forEach(btn => btn.classList.remove('is-active'));
        b.classList.add('is-active');
        this.selectedSplitType = b.dataset.split;
      };
    });

    // Envío del formulario
    if (form) {
      form.onsubmit = async (e) => {
        e.preventDefault();
        const rawAmount = amountInput.value;
        const amount = parseFloat(rawAmount);

        if (!amount || amount <= 0) {
          alert('Por favor ingresa un monto válido mayor a 0');
          amountInput.focus();
          return;
        }

        const noteInput = document.getElementById('quick-add-note');
        const dateInput = document.getElementById('quick-add-date');
        const payerSelect = document.getElementById('quick-add-payer');

        const activeMember = this.members.find(m => m.id === this.activeMemberId) || this.members[0];

        const newTx = sanitizeTransaction({
          id: generateId('tx'),
          amount,
          categoryId: this.selectedCatId || this.categories[0]?.id || 'cat_otros',
          paidByMemberId: payerSelect ? payerSelect.value : activeMember.id,
          splitType: this.selectedSplitType,
          date: dateInput?.value || formatISODate(new Date()),
          note: noteInput?.value || '',
          beneficiaryMemberIds: this.members.filter(m => m.isActive).map(m => m.id)
        });

        await db.put('transactions', newTx);
        this.syncEngine?.pushTransaction(newTx);
        
        // Haptic feedback en dispositivos compatibles
        if (navigator.vibrate) navigator.vibrate([15]);

        await this.refreshData();
        this.closeQuickAddModal();
        this.pwaManager.showToast('Gasto registrado con éxito');
        this.renderCurrentView();
      };
    }
  }

  openQuickAddModal() {
    const modal = document.getElementById('modal-quick-add');
    const amountInput = document.getElementById('quick-add-amount');
    const noteInput = document.getElementById('quick-add-note');
    const dateInput = document.getElementById('quick-add-date');
    const payerSelect = document.getElementById('quick-add-payer');
    const chipsContainer = document.getElementById('quick-add-category-chips');

    if (!modal) return;

    // Reset de campos
    if (amountInput) amountInput.value = '';
    if (noteInput) noteInput.value = '';
    if (dateInput) dateInput.value = formatISODate(new Date());

    // Poblar selector de pagadores
    if (payerSelect) {
      payerSelect.innerHTML = this.members.filter(m => m.isActive).map(m => `
        <option value="${m.id}" ${m.id === this.activeMemberId ? 'selected' : ''}>
          ${m.avatar} ${m.name}
        </option>
      `).join('');
    }

    // Renderizar chips de categoría
    if (chipsContainer) {
      const activeCats = this.categories.filter(c => !c.isArchived);
      this.selectedCatId = activeCats[0]?.id || null;

      chipsContainer.innerHTML = activeCats.map((cat, idx) => `
        <button type="button" class="category-chip-btn ${idx === 0 ? 'is-selected' : ''}" data-id="${cat.id}">
          <span style="font-size: 16px;">${cat.icon}</span>
          <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 80px;">${cat.name}</span>
        </button>
      `).join('');
    }

    modal.classList.add('is-open');

    // Auto-focus en el monto
    setTimeout(() => {
      if (amountInput) amountInput.focus();
    }, 120);
  }

  closeQuickAddModal() {
    const modal = document.getElementById('modal-quick-add');
    if (modal) modal.classList.remove('is-open');
    const amountInput = document.getElementById('quick-add-amount');
    if (amountInput) amountInput.blur();
  }

  // --- MODAL DE CATEGORÍA (NUEVA / EDITAR) ---
  setupCategoryModal() {
    const modal = document.getElementById('modal-category-edit');
    const closeBtn = document.getElementById('btn-close-cat-modal');
    const form = document.getElementById('form-category-edit');

    if (closeBtn) closeBtn.onclick = () => modal.classList.remove('is-open');
    if (modal) {
      modal.onclick = (e) => {
        if (e.target === modal) modal.classList.remove('is-open');
      };
    }

    if (form) {
      form.onsubmit = async (e) => {
        e.preventDefault();
        const id = document.getElementById('cat-edit-id').value || generateId('cat');
        const name = document.getElementById('cat-edit-name').value.trim();
        const icon = document.getElementById('cat-edit-icon').value.trim() || '📦';
        const color = document.getElementById('cat-edit-color').value || '#0284C7';
        const budget = parseFloat(document.getElementById('cat-edit-budget').value) || 0;

        const existing = this.categories.find(c => c.id === id);
        const catData = {
          id,
          name,
          icon,
          color,
          monthlyBudget: budget,
          isSystem: existing ? existing.isSystem : false,
          isArchived: false,
          displayOrder: existing ? existing.displayOrder : this.categories.length + 1
        };

        await db.put('categories', catData);
        await this.refreshData();
        modal.classList.remove('is-open');
        this.renderCurrentView();
        this.pwaManager.showToast('Categoría guardada');
      };
    }
  }

  openCategoryModal(cat = null) {
    const modal = document.getElementById('modal-category-edit');
    if (!modal) return;

    document.getElementById('cat-modal-title').textContent = cat ? 'EDITAR CATEGORÍA' : 'NUEVA CATEGORÍA';
    document.getElementById('cat-edit-id').value = cat ? cat.id : '';
    document.getElementById('cat-edit-name').value = cat ? cat.name : '';
    document.getElementById('cat-edit-icon').value = cat ? cat.icon : '🛒';
    document.getElementById('cat-edit-color').value = cat ? cat.color : '#0284C7';
    document.getElementById('cat-edit-budget').value = cat ? cat.monthlyBudget || '' : '';

    modal.classList.add('is-open');
  }

  // --- MODAL DE MIEMBRO (CREAR / EDITAR) ---
  setupMemberModal() {
    const modal = document.getElementById('modal-member-edit');
    const closeBtn = document.getElementById('btn-close-member-modal');
    const form = document.getElementById('form-member-edit');

    if (closeBtn) closeBtn.onclick = () => modal.classList.remove('is-open');
    if (modal) {
      modal.onclick = (e) => {
        if (e.target === modal) modal.classList.remove('is-open');
      };
    }

    if (form) {
      form.onsubmit = async (e) => {
        e.preventDefault();
        const id = document.getElementById('mem-edit-id')?.value;
        const name = document.getElementById('mem-edit-name').value.trim();
        const avatar = document.getElementById('mem-edit-avatar').value.trim() || '👤';
        const color = document.getElementById('mem-edit-color')?.value || '#0284C7';

        if (id) {
          // Edición de miembro existente
          const existing = this.members.find(m => m.id === id);
          if (existing) {
            existing.name = name;
            existing.avatar = avatar;
            existing.color = color;
            await db.put('members', existing);
            this.pwaManager.showToast(`Miembro "${name}" actualizado`);
          }
        } else {
          // Creación de nuevo miembro
          const newMember = {
            id: generateId('m'),
            name,
            avatar,
            color,
            isActive: true,
            createdAt: new Date().toISOString()
          };
          await db.put('members', newMember);
          this.pwaManager.showToast(`Miembro "${name}" añadido`);
        }

        await this.refreshData();
        modal.classList.remove('is-open');
        this.renderMembersView();
      };
    }
  }

  openMemberModal(member = null) {
    const modal = document.getElementById('modal-member-edit');
    if (!modal) return;

    const titleEl = document.getElementById('mem-modal-title');
    const submitEl = document.getElementById('mem-modal-submit');
    const idEl = document.getElementById('mem-edit-id');
    const nameEl = document.getElementById('mem-edit-name');
    const avatarEl = document.getElementById('mem-edit-avatar');
    const colorEl = document.getElementById('mem-edit-color');

    if (titleEl) titleEl.textContent = member ? 'EDITAR MIEMBRO' : 'NUEVO MIEMBRO DEL HOGAR';
    if (submitEl) submitEl.textContent = member ? 'GUARDAR CAMBIOS' : 'AÑADIR MIEMBRO';
    if (idEl) idEl.value = member ? member.id : '';
    if (nameEl) nameEl.value = member ? member.name : '';
    if (avatarEl) avatarEl.value = member ? member.avatar : '👤';
    if (colorEl) colorEl.value = member ? (member.color || '#0284C7') : '#0284C7';

    modal.classList.add('is-open');
    setTimeout(() => {
      if (nameEl) nameEl.focus();
    }, 120);
  }

  // --- MODAL DE LIQUIDACIÓN FORMAL ---
  setupSettlementModal() {
    const modal = document.getElementById('modal-settlement');
    const closeBtn = document.getElementById('btn-close-settlement');
    const confirmBtn = document.getElementById('btn-confirm-settlement');

    if (closeBtn) closeBtn.onclick = () => modal.classList.remove('is-open');
    if (modal) {
      modal.onclick = (e) => {
        if (e.target === modal) modal.classList.remove('is-open');
      };
    }

    if (confirmBtn) {
      confirmBtn.onclick = async () => {
        const debtorId = confirmBtn.dataset.debtorId;
        const creditorId = confirmBtn.dataset.creditorId;
        const amount = parseFloat(confirmBtn.dataset.amount);

        const settlementTx = sanitizeTransaction({
          id: generateId('settle'),
          amount,
          categoryId: 'cat_otros',
          paidByMemberId: debtorId,
          beneficiaryMemberIds: [creditorId],
          splitType: SplitTypes.SETTLEMENT,
          date: formatISODate(new Date()),
          note: 'Liquidación de balance: Cuentas saldadas',
          isSettlement: true
        });

        await db.put('transactions', settlementTx);
        this.syncEngine?.pushTransaction(settlementTx);
        await this.refreshData();
        modal.classList.remove('is-open');
        this.renderMembersView();
        this.pwaManager.showToast('¡Deuda saldada formalmente!');
      };
    }
  }

  openSettlementModal(settlement) {
    const modal = document.getElementById('modal-settlement');
    const descEl = document.getElementById('settlement-description');
    const confirmBtn = document.getElementById('btn-confirm-settlement');

    if (!modal || !confirmBtn) return;

    descEl.innerHTML = `
      ¿Confirmas que <b>${settlement.debtorAvatar} ${settlement.debtorName}</b> ha transferido 
      <b style="color: var(--coral-expense); font-family: var(--font-mono);">${settlement.formattedAmount}</b> 
      a <b>${settlement.creditorAvatar} ${settlement.creditorName}</b> para saldar sus cuentas?
    `;

    confirmBtn.dataset.debtorId = settlement.debtorId;
    confirmBtn.dataset.creditorId = settlement.creditorId;
    confirmBtn.dataset.amount = settlement.amount;

    modal.classList.add('is-open');
  }

  setupSettingsActions() {
    // Configurado dinámicamente en renderSettingsView
  }
}

// Iniciar aplicación al cargar el DOM
window.addEventListener('DOMContentLoaded', () => {
  const app = new AppController();
  app.init().catch(err => {
    console.error('Error al iniciar GastoCasa App:', err);
  });
});
