// Motor de Base de Datos Nativo IndexedDB - Cero Dependencias
import { DEFAULT_MEMBERS, DEFAULT_CATEGORIES, DEFAULT_SETTINGS, sanitizeTransaction } from './models.js';

const DB_NAME = 'gastocasa_db';
const DB_VERSION = 1;

class Database {
  constructor() {
    this.db = null;
  }

  async init() {
    if (this.db) return this.db;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Almacén: Transacciones
        if (!db.objectStoreNames.contains('transactions')) {
          const txStore = db.createObjectStore('transactions', { keyPath: 'id' });
          txStore.createIndex('date', 'date', { unique: false });
          txStore.createIndex('categoryId', 'categoryId', { unique: false });
          txStore.createIndex('paidByMemberId', 'paidByMemberId', { unique: false });
        }

        // Almacén: Categorías
        if (!db.objectStoreNames.contains('categories')) {
          db.createObjectStore('categories', { keyPath: 'id' });
        }

        // Almacén: Miembros
        if (!db.objectStoreNames.contains('members')) {
          db.createObjectStore('members', { keyPath: 'id' });
        }

        // Almacén: Ajustes
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'id' });
        }
      };

      request.onsuccess = async (event) => {
        this.db = event.target.result;

        // Recuperación ante desconexión o suspensión del daemon IndexedDB en iOS WebKit
        this.db.onclose = () => {
          console.warn('[DB] Conexión IndexedDB cerrada por el sistema. Reinicializando...');
          this.db = null;
        };
        this.db.onversionchange = () => {
          if (this.db) {
            this.db.close();
            this.db = null;
          }
        };

        try {
          await this.ensureInitialSeed();
        } catch (seedErr) {
          console.warn('[DB] Error no bloqueante en ensureInitialSeed:', seedErr);
        }
        resolve(this.db);
      };

      request.onerror = (event) => {
        console.error('Error al inicializar IndexedDB:', event.target.error);
        this.db = null;
        reject(event.target.error);
      };
    });
  }

  // Si la base está recién creada, inyectar miembros, categorías y configuración base
  async ensureInitialSeed() {
    const categories = await this.getAll('categories');
    if (categories.length === 0) {
      for (const cat of DEFAULT_CATEGORIES) {
        await this.put('categories', cat);
      }
    }

    const members = await this.getAll('members');
    if (members.length === 0) {
      for (const m of DEFAULT_MEMBERS) {
        await this.put('members', m);
      }
    }

    const settings = await this.get('settings', 'main_settings');
    if (!settings) {
      await this.put('settings', { id: 'main_settings', ...DEFAULT_SETTINGS });
    }
  }

  async getAll(storeName) {
    const db = await this.init();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      } catch (err) {
        if (err.name === 'InvalidStateError' || err.message?.includes('closed')) {
          this.db = null;
        }
        reject(err);
      }
    });
  }

  async get(storeName, id) {
    const db = await this.init();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const req = store.get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      } catch (err) {
        if (err.name === 'InvalidStateError' || err.message?.includes('closed')) {
          this.db = null;
        }
        reject(err);
      }
    });
  }

  async put(storeName, item) {
    // Protección estricta: si es settings, asegurar que siempre tenga la clave primaria 'id'
    if (storeName === 'settings' && item && !item.id) {
      item.id = 'main_settings';
    }

    const db = await this.init();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        let result = null;

        const req = store.put(item);
        req.onsuccess = () => {
          result = req.result;
        };
        req.onerror = () => reject(req.error);

        // En Safari/iOS WebKit, esperar a tx.oncomplete garantiza persistencia física en disco
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error || req.error);
        tx.onabort = () => reject(tx.error || new Error('Transacción abortada'));
      } catch (err) {
        if (err.name === 'InvalidStateError' || err.message?.includes('closed')) {
          this.db = null;
        }
        reject(err);
      }
    });
  }

  async delete(storeName, id) {
    const db = await this.init();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const req = store.delete(id);
        req.onerror = () => reject(req.error);

        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error || req.error);
        tx.onabort = () => reject(tx.error || new Error('Transacción abortada'));
      } catch (err) {
        if (err.name === 'InvalidStateError' || err.message?.includes('closed')) {
          this.db = null;
        }
        reject(err);
      }
    });
  }

  async clear(storeName) {
    const db = await this.init();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const req = store.clear();
        req.onerror = () => reject(req.error);

        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error || req.error);
        tx.onabort = () => reject(tx.error || new Error('Transacción abortada'));
      } catch (err) {
        if (err.name === 'InvalidStateError' || err.message?.includes('closed')) {
          this.db = null;
        }
        reject(err);
      }
    });
  }

  // Exportar todo el contenido de la BD para backup
  async exportAllData() {
    const [transactions, categories, members, settings] = await Promise.all([
      this.getAll('transactions'),
      this.getAll('categories'),
      this.getAll('members'),
      this.getAll('settings')
    ]);

    return {
      appName: 'GastoCasa // Brutal',
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      data: {
        transactions,
        categories,
        members,
        settings
      }
    };
  }

  // Importar de forma segura validando firma y arrays
  async importAllData(backup) {
    if (!backup || !backup.data || !Array.isArray(backup.data.transactions)) {
      throw new Error('Archivo de respaldo inválido o corrupto.');
    }

    const { transactions, categories, members, settings } = backup.data;

    // Limpiar almacenes actuales
    await this.clear('transactions');
    await this.clear('categories');
    await this.clear('members');
    await this.clear('settings');

    // Restaurar colecciones
    for (const cat of (categories || DEFAULT_CATEGORIES)) {
      await this.put('categories', cat);
    }
    for (const m of (members || DEFAULT_MEMBERS)) {
      await this.put('members', m);
    }
    for (const tx of transactions) {
      await this.put('transactions', sanitizeTransaction(tx));
    }
    for (const s of (settings || [])) {
      await this.put('settings', s);
    }

    return true;
  }

  // Inyectar datos demo realistas
  async loadDemoData() {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');

    // Generar fechas en el mes actual
    const d = (day) => `${year}-${month}-${String(day).padStart(2, '0')}`;

    const demoTx = [
      { id: 'tx_demo_1', amount: 1850.50, categoryId: 'cat_super', paidByMemberId: 'm_laura', splitType: 'SHARED_EQUAL', date: d(2), note: 'Despensa quincenal Walmart' },
      { id: 'tx_demo_2', amount: 620.00, categoryId: 'cat_servicios', paidByMemberId: 'm_carlos', splitType: 'SHARED_EQUAL', date: d(3), note: 'Recibo de Luz CFE' },
      { id: 'tx_demo_3', amount: 7500.00, categoryId: 'cat_hogar', paidByMemberId: 'm_laura', splitType: 'SHARED_EQUAL', date: d(5), note: 'Pago de Renta mensual' },
      { id: 'tx_demo_4', amount: 480.00, categoryId: 'cat_salidas', paidByMemberId: 'm_carlos', splitType: 'SHARED_EQUAL', date: d(6), note: 'Pizzas y cena fin de semana' },
      { id: 'tx_demo_5', amount: 350.00, categoryId: 'cat_transporte', paidByMemberId: 'm_carlos', splitType: 'PERSONAL', date: d(8), note: 'Gasolina personal' },
      { id: 'tx_demo_6', amount: 1250.00, categoryId: 'cat_super', paidByMemberId: 'm_carlos', splitType: 'SHARED_EQUAL', date: d(10), note: 'Frutas, verduras y carnicería' },
      { id: 'tx_demo_7', amount: 890.00, categoryId: 'cat_servicios', paidByMemberId: 'm_laura', splitType: 'SHARED_EQUAL', date: d(11), note: 'Internet fibra óptica' },
      { id: 'tx_demo_8', amount: 420.00, categoryId: 'cat_mascotas', paidByMemberId: 'm_laura', splitType: 'SHARED_EQUAL', date: d(13), note: 'Alimento para el perro' },
      { id: 'tx_demo_9', amount: 380.00, categoryId: 'cat_salud', paidByMemberId: 'm_carlos', splitType: 'DIRECT_DEBT', beneficiaryMemberIds: ['m_laura'], date: d(14), note: 'Medicamentos encargados para Laura' },
      { id: 'tx_demo_10', amount: 1620.00, categoryId: 'cat_super', paidByMemberId: 'm_laura', splitType: 'SHARED_EQUAL', date: d(16), note: 'Despensa segunda quincena' },
      { id: 'tx_demo_11', amount: 550.00, categoryId: 'cat_transporte', paidByMemberId: 'm_laura', splitType: 'SHARED_EQUAL', date: d(18), note: 'Uber compartido viaje familiar' },
      { id: 'tx_demo_12', amount: 680.00, categoryId: 'cat_salidas', paidByMemberId: 'm_laura', splitType: 'SHARED_EQUAL', date: d(20), note: 'Cafetería y cine' }
    ];

    for (const item of demoTx) {
      await this.put('transactions', sanitizeTransaction(item));
    }
  }

  // Purgar todos los movimientos
  async resetTransactions() {
    await this.clear('transactions');
  }
}

export const db = new Database();
