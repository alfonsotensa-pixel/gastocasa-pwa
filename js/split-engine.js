// Motor de Cálculo Matemático, Reparto de Gastos y Fechas ISO-8601
import { SplitTypes, formatMoney } from './models.js';

// Operaciones estrictas en centavos enteros para evitar errores de coma flotante
export const toCents = (amount) => Math.round((Number(amount) || 0) * 100);
export const toMoney = (cents) => (cents / 100);

// --- UTILIDADES DE FECHAS (ISO-8601) ---

// Obtener rango de la semana ISO (Lunes a Domingo)
export function getISOWeekRange(dateInput = new Date()) {
  const d = new Date(dateInput);
  // En JS: 0=Domingo, 1=Lunes, ..., 6=Sábado
  const day = d.getDay();
  // Diferencia para llegar al Lunes (si es domingo=0, restar 6; si es lunes=1, restar 0, etc.)
  const diffToMonday = day === 0 ? -6 : 1 - day;
  
  const monday = new Date(d);
  monday.setDate(d.getDate() + diffToMonday);
  
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const days = [];
  for (let i = 0; i < 7; i++) {
    const cur = new Date(monday);
    cur.setDate(monday.getDate() + i);
    days.push(formatISODate(cur));
  }

  return {
    startDate: formatISODate(monday),
    endDate: formatISODate(sunday),
    days,
    label: `${formatShortDate(monday)} - ${formatShortDate(sunday)}`
  };
}

// Obtener rango de un mes completo
export function getMonthRange(year, month) {
  // month: 0-11
  const start = new Date(year, month, 1);
  const end = new Date(year, month + 1, 0); // Último día del mes

  return {
    startDate: formatISODate(start),
    endDate: formatISODate(end),
    totalDays: end.getDate(),
    label: start.toLocaleDateString('es-MX', { month: 'long', year: 'numeric' })
  };
}

// Obtener rango de un año completo
export function getYearRange(year) {
  return {
    startDate: `${year}-01-01`,
    endDate: `${year}-12-31`,
    label: `Año ${year}`
  };
}

export function formatISODate(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function formatShortDate(d) {
  return d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
}

// Filtrar transacciones por rango de fechas [start, end]
export function filterTransactionsByDate(transactions, startDate, endDate) {
  return transactions.filter(t => t.date >= startDate && t.date <= endDate);
}

// --- CÁLCULO DE MÉTRICAS Y AGREGACIONES ---

export function computePeriodMetrics(transactions, categoriesMap, membersMap) {
  // Filtrar transacciones que no sean 'settlement' para estadísticas de gasto real
  const expenseTx = transactions.filter(t => !t.isSettlement && t.type === 'expense');

  let totalCents = 0;
  const categoryTotalsCents = {};
  const memberPaidCents = {};

  expenseTx.forEach(tx => {
    const cents = toCents(tx.amount);
    totalCents += cents;

    // Por categoría
    categoryTotalsCents[tx.categoryId] = (categoryTotalsCents[tx.categoryId] || 0) + cents;

    // Por miembro pagador
    memberPaidCents[tx.paidByMemberId] = (memberPaidCents[tx.paidByMemberId] || 0) + cents;
  });

  const totalExpense = toMoney(totalCents);

  // Ordenar categorías por mayor gasto
  const categoryBreakdown = Object.entries(categoryTotalsCents)
    .map(([catId, cents]) => {
      const amount = toMoney(cents);
      const cat = categoriesMap[catId] || { name: 'Sin categoría', icon: '❓', color: '#64748B' };
      const percentage = totalCents > 0 ? Math.round((cents / totalCents) * 100) : 0;
      return {
        categoryId: catId,
        name: cat.name,
        icon: cat.icon,
        color: cat.color,
        amount,
        cents,
        percentage
      };
    })
    .sort((a, b) => b.cents - a.cents);

  // Miembro con mayor aporte
  let topSpender = null;
  let maxMemberCents = -1;
  Object.entries(memberPaidCents).forEach(([mId, cents]) => {
    if (cents > maxMemberCents) {
      maxMemberCents = cents;
      topSpender = membersMap[mId] || { name: 'Desconocido' };
    }
  });

  return {
    totalExpense,
    totalCount: expenseTx.length,
    categoryBreakdown,
    topCategory: categoryBreakdown[0] || null,
    topSpender,
    memberPaidCents
  };
}

// --- ALGORITMO DE BALANCES Y LIQUIDACIÓN DOMÉSTICA ---

/**
 * Calcula la matriz de deudas netas entre miembros del hogar.
 * Reglas:
 * 1. SHARED_EQUAL: El gasto se divide en partes iguales entre los miembros activos.
 *    Quien pagó desembolsó la cuota de todos los demás.
 * 2. PERSONAL: No genera deuda. Computa solo como gasto personal.
 * 3. DIRECT_DEBT: Pagado por A exclusivamente para B. B le debe el 100% a A.
 * 4. SETTLEMENT: A pagó a B para saldar deuda. Reduce la deuda de A hacia B.
 */
export function calculateHouseholdBalances(allTransactions, activeMembers) {
  if (activeMembers.length < 2) return [];

  // Matriz de deudas bilaterales: debts[debtorId][creditorId] = cents
  const debts = {};
  activeMembers.forEach(m1 => {
    debts[m1.id] = {};
    activeMembers.forEach(m2 => {
      debts[m1.id][m2.id] = 0;
    });
  });

  const activeCount = activeMembers.length;
  const activeIds = activeMembers.map(m => m.id);

  allTransactions.forEach(tx => {
    const payerId = tx.paidByMemberId;
    if (!debts[payerId]) return; // Miembro inactivo o fuera de la casa

    const cents = toCents(tx.amount);

    if (tx.isSettlement) {
      // Liquidación: El pagador le transfiere al beneficiario para saldar
      const creditorId = tx.beneficiaryMemberIds?.[0];
      if (creditorId && debts[payerId][creditorId] !== undefined) {
        // Reduce lo que payerId le debía a creditorId
        debts[payerId][creditorId] -= cents;
      }
      return;
    }

    if (tx.splitType === SplitTypes.SHARED_EQUAL) {
      // Cada miembro activo consume shareCents
      const shareCents = Math.floor(cents / activeCount);
      // Remanente de redondeo de centavos
      const remainder = cents % activeCount;

      activeMembers.forEach((m, idx) => {
        if (m.id !== payerId) {
          // Si hay centavo sobrante, se asigna al primer participante
          const extra = (idx === 0) ? remainder : 0;
          debts[m.id][payerId] += (shareCents + extra);
        }
      });
    } else if (tx.splitType === SplitTypes.DIRECT_DEBT) {
      const debtorId = tx.beneficiaryMemberIds?.[0];
      if (debtorId && debtorId !== payerId && debts[debtorId]?.[payerId] !== undefined) {
        debts[debtorId][payerId] += cents;
      }
    }
  });

  // Simplificación Bilateral:
  // Si A le debe $500 a B, y B le debe $200 a A -> Deuda neta: A le debe $300 a B.
  const settlementSuggestions = [];
  const processedPairs = new Set();

  for (let i = 0; i < activeMembers.length; i++) {
    for (let j = i + 1; j < activeMembers.length; j++) {
      const m1 = activeMembers[i];
      const m2 = activeMembers[j];

      const m1OwesM2 = debts[m1.id][m2.id] || 0;
      const m2OwesM1 = debts[m2.id][m1.id] || 0;
      const netCents = m1OwesM2 - m2OwesM1;

      if (netCents > 0) {
        // m1 le debe a m2
        settlementSuggestions.push({
          debtorId: m1.id,
          debtorName: m1.name,
          debtorAvatar: m1.avatar,
          creditorId: m2.id,
          creditorName: m2.name,
          creditorAvatar: m2.avatar,
          amountCents: netCents,
          amount: toMoney(netCents),
          formattedAmount: formatMoney(toMoney(netCents))
        });
      } else if (netCents < 0) {
        // m2 le debe a m1
        const absCents = Math.abs(netCents);
        settlementSuggestions.push({
          debtorId: m2.id,
          debtorName: m2.name,
          debtorAvatar: m2.avatar,
          creditorId: m1.id,
          creditorName: m1.name,
          creditorAvatar: m1.avatar,
          amountCents: absCents,
          amount: toMoney(absCents),
          formattedAmount: formatMoney(toMoney(absCents))
        });
      }
    }
  }

  return settlementSuggestions;
}
