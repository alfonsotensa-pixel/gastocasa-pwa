// Modelos de Datos, Enums y Valores por Defecto
export const SplitTypes = {
  SHARED_EQUAL: 'SHARED_EQUAL', // Gasto común del hogar (dividido entre todos los miembros activos)
  PERSONAL: 'PERSONAL',         // Gasto propio (no genera deuda en el hogar)
  DIRECT_DEBT: 'DIRECT_DEBT',   // Miembro A pagó exclusivamente por Miembro B (100% deuda)
  SETTLEMENT: 'SETTLEMENT'      // Ajuste contable formal de pago de deuda entre dos miembros
};

export const DEFAULT_MEMBERS = [
  {
    id: 'm_laura',
    name: 'Laura',
    avatar: '👩',
    color: '#0284C7',
    isActive: true,
    createdAt: new Date().toISOString()
  },
  {
    id: 'm_carlos',
    name: 'Carlos',
    avatar: '👨',
    color: '#059669',
    isActive: true,
    createdAt: new Date().toISOString()
  }
];

export const DEFAULT_CATEGORIES = [
  {
    id: 'cat_super',
    name: 'Supermercado',
    icon: '🛒',
    color: '#0284C7',
    monthlyBudget: 6000,
    isSystem: true,
    isArchived: false,
    displayOrder: 1
  },
  {
    id: 'cat_servicios',
    name: 'Luz, Agua e Internet',
    icon: '⚡',
    color: '#D97706',
    monthlyBudget: 2500,
    isSystem: true,
    isArchived: false,
    displayOrder: 2
  },
  {
    id: 'cat_hogar',
    name: 'Renta / Hogar',
    icon: '🏠',
    color: '#1C2541',
    monthlyBudget: 12000,
    isSystem: true,
    isArchived: false,
    displayOrder: 3
  },
  {
    id: 'cat_transporte',
    name: 'Transporte / Gasolina',
    icon: '🚗',
    color: '#3B82F6',
    monthlyBudget: 3000,
    isSystem: false,
    isArchived: false,
    displayOrder: 4
  },
  {
    id: 'cat_salud',
    name: 'Salud y Farmacia',
    icon: '💊',
    color: '#E11D48',
    monthlyBudget: 1500,
    isSystem: false,
    isArchived: false,
    displayOrder: 5
  },
  {
    id: 'cat_salidas',
    name: 'Restaurantes y Ocio',
    icon: '🍕',
    color: '#8B5CF6',
    monthlyBudget: 3500,
    isSystem: false,
    isArchived: false,
    displayOrder: 6
  },
  {
    id: 'cat_mascotas',
    name: 'Mascotas',
    icon: '🐾',
    color: '#10B981',
    monthlyBudget: 1200,
    isSystem: false,
    isArchived: false,
    displayOrder: 7
  },
  {
    id: 'cat_otros',
    name: 'Otros Gastos',
    icon: '📦',
    color: '#64748B',
    monthlyBudget: 1000,
    isSystem: true,
    isArchived: false,
    displayOrder: 8
  }
];

export const DEFAULT_SETTINGS = {
  householdName: 'Hogar Compartido',
  currencySymbol: '$',
  activeMemberId: 'm_laura',
  weekStartsOn: 1, // 1 = Lunes (ISO-8601)
  theme: 'light',
  lastBackupDate: null
};

// Generador de IDs únicos seguros
export function generateId(prefix = 'id') {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

// Formateo de moneda estricto y limpio
export function formatMoney(amount, currency = '$') {
  const num = Number(amount) || 0;
  return `${currency} ${num.toLocaleString('es-MX', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

// Sanitización de transacción
export function sanitizeTransaction(data) {
  const amount = Math.round(Number(data.amount || 0) * 100) / 100;
  return {
    id: data.id || generateId('tx'),
    type: data.type || 'expense',
    amount: Math.max(0, amount),
    categoryId: data.categoryId || 'cat_otros',
    paidByMemberId: data.paidByMemberId || '',
    splitType: data.splitType || SplitTypes.SHARED_EQUAL,
    beneficiaryMemberIds: Array.isArray(data.beneficiaryMemberIds) ? data.beneficiaryMemberIds : [],
    date: data.date || new Date().toISOString().split('T')[0],
    note: (data.note || '').trim(),
    isSettlement: Boolean(data.isSettlement),
    createdAt: data.createdAt || Date.now(),
    updatedAt: Date.now()
  };
}
