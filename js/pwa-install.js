// Gestión de PWA: Service Worker, Instalación Móvil (A2HS), Persistencia y Exportación
import { db } from './db.js';

let deferredPrompt = null;

export class PWAManager {
  constructor() {
    this.installBtn = document.getElementById('btn-install-pwa');
    this.iosModal = document.getElementById('ios-install-modal');
  }

  init() {
    this.registerServiceWorker();
    this.requestStoragePersistence();
    this.setupInstallPrompt();
    this.setupExportImportHandlers();
  }

  // Registrar Service Worker para funcionamiento Offline
  async registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      try {
        const registration = await navigator.serviceWorker.register('./sw.js');
        console.log('[PWA] Service Worker registrado con éxito:', registration.scope);
      } catch (err) {
        console.warn('[PWA] Error al registrar Service Worker:', err);
      }
    }
  }

  // Prevención de purga en Safari iOS (ITP): solicitar almacenamiento persistente
  async requestStoragePersistence() {
    if (navigator.storage && navigator.storage.persist) {
      try {
        const isPersisted = await navigator.storage.persist();
        console.log('[Storage] Almacenamiento persistente garantizado:', isPersisted);
      } catch (e) {
        console.warn('[Storage] No se pudo solicitar persistencia:', e);
      }
    }
  }

  // Detección y disparo del asistente A2HS (Add To Home Screen)
  setupInstallPrompt() {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

    // Caso Android / Chrome: evento beforeinstallprompt
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      if (this.installBtn) {
        this.installBtn.classList.add('is-visible');
        this.installBtn.onclick = async () => {
          if (!deferredPrompt) return;
          deferredPrompt.prompt();
          const { outcome } = await deferredPrompt.userChoice;
          console.log('[PWA] Respuesta de instalación del usuario:', outcome);
          deferredPrompt = null;
          this.installBtn.classList.remove('is-visible');
        };
      }
    });

    // Caso iOS Safari: si no está instalada, mostrar botón con modal instructivo
    if (isIOS && !isStandalone && this.installBtn) {
      this.installBtn.classList.add('is-visible');
      this.installBtn.onclick = () => {
        if (this.iosModal) {
          this.iosModal.classList.add('is-open');
        }
      };
    }

    // Ocultar si ya se instaló
    window.addEventListener('appinstalled', () => {
      console.log('[PWA] Aplicación instalada en el dispositivo.');
      if (this.installBtn) {
        this.installBtn.classList.remove('is-visible');
      }
    });
  }

  // Configuración de Respaldos: Exportar JSON, Exportar CSV e Importar
  setupExportImportHandlers() {
    const btnExportJson = document.getElementById('btn-export-json');
    const btnExportCsv = document.getElementById('btn-export-csv');
    const btnImport = document.getElementById('btn-import-json');
    const fileInput = document.getElementById('file-import-input');

    if (btnExportJson) {
      btnExportJson.onclick = async () => {
        try {
          const data = await db.exportAllData();
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
          const today = new Date().toISOString().split('T')[0];
          this.downloadBlob(blob, `gastos-hogar-backup-${today}.json`);
          this.showToast('Respaldo JSON descargado');
        } catch (err) {
          alert('Error al exportar datos: ' + err.message);
        }
      };
    }

    if (btnExportCsv) {
      btnExportCsv.onclick = async () => {
        try {
          const [transactions, categories, members] = await Promise.all([
            db.getAll('transactions'),
            db.getAll('categories'),
            db.getAll('members')
          ]);

          const catMap = Object.fromEntries(categories.map(c => [c.id, c.name]));
          const memMap = Object.fromEntries(members.map(m => [m.id, m.name]));

          let csvContent = 'ID,Fecha,Categoría,Monto,Pagado Por,Tipo Reparto,Nota,Liquidación\n';
          transactions.forEach(t => {
            const row = [
              t.id,
              t.date,
              `"${(catMap[t.categoryId] || t.categoryId).replace(/"/g, '""')}"`,
              t.amount.toFixed(2),
              `"${(memMap[t.paidByMemberId] || t.paidByMemberId).replace(/"/g, '""')}"`,
              t.splitType,
              `"${(t.note || '').replace(/"/g, '""')}"`,
              t.isSettlement ? 'SI' : 'NO'
            ];
            csvContent += row.join(',') + '\n';
          });

          const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
          const today = new Date().toISOString().split('T')[0];
          this.downloadBlob(blob, `gastos-hogar-${today}.csv`);
          this.showToast('Archivo CSV descargado para Excel');
        } catch (err) {
          alert('Error al exportar CSV: ' + err.message);
        }
      };
    }

    if (btnImport && fileInput) {
      btnImport.onclick = () => fileInput.click();

      fileInput.onchange = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;

        try {
          const text = await file.text();
          const json = JSON.parse(text);

          const confirmReset = confirm(
            'ATENCIÓN: Importar un respaldo reemplazará los datos actuales en el dispositivo.\n\n¿Deseas continuar?'
          );
          if (!confirmReset) return;

          await db.importAllData(json);
          this.showToast('Datos restaurados correctamente');
          setTimeout(() => window.location.reload(), 600);
        } catch (err) {
          alert('Error al restaurar respaldo: ' + err.message);
        } finally {
          fileInput.value = '';
        }
      };
    }
  }

  downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  showToast(message) {
    let toast = document.querySelector('.toast-notice');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'toast-notice';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('is-show');
    setTimeout(() => toast.classList.remove('is-show'), 2500);
  }
}
