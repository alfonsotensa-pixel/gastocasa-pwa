// Generador Declarativo de Gráficos SVG Nativos - Estilo Neo-Brutalista
import { formatMoney } from './models.js';

export class BrutalistChartEngine {
  constructor(containerId, projectionCardId) {
    this.container = document.getElementById(containerId);
    this.projectionCard = document.getElementById(projectionCardId);
    this.activeBarIndex = null;
  }

  /**
   * Renderiza el histograma temporal adaptable a Semana (7 barras), Mes (semanas/días) o Año (12 barras)
   * @param {Array<{ label: string, value: number, count: number, fullDate?: string }>} items 
   */
  renderHistogram(items = []) {
    if (!this.container) return;
    this.container.innerHTML = '';

    if (items.length === 0) {
      this.container.innerHTML = `
        <div style="text-align: center; padding: 24px; font-family: var(--font-mono); font-size: 11px; font-weight: 700; color: var(--ink-secondary);">
          SIN DATOS PARA GRAFICAR EN ESTE PERIODO
        </div>
      `;
      this.updateProjectionCard('Toca una barra para ver detalles', '$ 0.00');
      return;
    }

    const svgWidth = 360;
    const svgHeight = 140;
    const paddingLeft = 32;
    const paddingRight = 12;
    const paddingTop = 20;
    const paddingBottom = 26;

    const chartWidth = svgWidth - paddingLeft - paddingRight;
    const chartHeight = svgHeight - paddingTop - paddingBottom;

    // Calcular valor máximo para escala vertical
    const maxVal = Math.max(...items.map(i => i.value), 10);
    // Redondear a un número superior amigable
    const yMax = Math.ceil(maxVal * 1.15);

    const totalBars = items.length;
    const barSpacing = Math.max(2, Math.min(6, Math.floor(chartWidth / (totalBars * 4))));
    const barWidth = Math.max(10, Math.floor((chartWidth - (barSpacing * (totalBars + 1))) / totalBars));

    let svgHtml = `
      <svg class="chart-svg" viewBox="0 0 ${svgWidth} ${svgHeight}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
        <!-- Rejilla y Eje Base Brutalista -->
        <line x1="${paddingLeft}" y1="${svgHeight - paddingBottom}" x2="${svgWidth - paddingRight}" y2="${svgHeight - paddingBottom}" 
              stroke="#D1D5DB" stroke-width="1" />
        <line x1="${paddingLeft}" y1="${paddingTop + (chartHeight / 2)}" x2="${svgWidth - paddingRight}" y2="${paddingTop + (chartHeight / 2)}" 
              stroke="#CBD5E1" stroke-width="1" stroke-dasharray="3 3" />
        <line x1="${paddingLeft}" y1="${paddingTop}" x2="${svgWidth - paddingRight}" y2="${paddingTop}" 
              stroke="#CBD5E1" stroke-width="1" stroke-dasharray="3 3" />

        <!-- Etiquetas de Eje Y -->
        <text x="${paddingLeft - 4}" y="${paddingTop + 4}" font-family="monospace" font-size="8" font-weight="700" fill="#64748B" text-anchor="end">
          ${this.formatCompactNumber(yMax)}
        </text>
        <text x="${paddingLeft - 4}" y="${paddingTop + (chartHeight / 2) + 3}" font-family="monospace" font-size="8" font-weight="700" fill="#64748B" text-anchor="end">
          ${this.formatCompactNumber(yMax / 2)}
        </text>
        <text x="${paddingLeft - 4}" y="${svgHeight - paddingBottom + 1}" font-family="monospace" font-size="8" font-weight="700" fill="#64748B" text-anchor="end">
          0
        </text>
    `;

    // Barras
    items.forEach((item, index) => {
      const x = paddingLeft + barSpacing + index * (barWidth + barSpacing);
      const barH = item.value > 0 ? Math.max(3, Math.round((item.value / yMax) * chartHeight)) : 2;
      const y = (svgHeight - paddingBottom) - barH;

      const fill = item.value > 0 ? '#1C2541' : '#E5E7EB';

      svgHtml += `
        <g class="chart-bar-group" data-index="${index}" style="cursor: pointer;">
          <!-- Barra interactiva -->
          <rect class="chart-bar" x="${x}" y="${y}" width="${barWidth}" height="${barH}" 
                fill="${fill}" rx="4" ry="4" data-index="${index}" />
          <!-- Etiqueta Eje X -->
          <text x="${x + (barWidth / 2)}" y="${svgHeight - paddingBottom + 14}" 
                font-family="system-ui, sans-serif" font-size="${totalBars > 8 ? 8 : 9}" font-weight="500" fill="#6B7280" text-anchor="middle">
            ${item.label}
          </text>
        </g>
      `;
    });

    svgHtml += `</svg>`;
    this.container.innerHTML = svgHtml;

    // Vincular interacción táctil a la Touch Projection Card
    const barGroups = this.container.querySelectorAll('.chart-bar-group');
    barGroups.forEach((group) => {
      const idx = Number(group.dataset.index);
      const triggerSelect = () => {
        this.selectBar(idx, items[idx]);
        // Quitar estado activo previo
        this.container.querySelectorAll('.chart-bar').forEach(b => b.classList.remove('is-active'));
        const barRect = group.querySelector('.chart-bar');
        if (barRect) barRect.classList.add('is-active');
      };

      group.addEventListener('click', triggerSelect);
      group.addEventListener('touchstart', (e) => {
        triggerSelect();
      }, { passive: true });
    });

    // Seleccionar por defecto el día o periodo con mayor gasto o el último
    if (items.length > 0) {
      const latestWithData = [...items].reverse().find(i => i.value > 0) || items[items.length - 1];
      const defaultIdx = items.indexOf(latestWithData);
      this.selectBar(defaultIdx, latestWithData);
    }
  }

  selectBar(index, item) {
    this.activeBarIndex = index;
    if (!item) return;

    const labelText = item.fullDate || item.label;
    const countText = item.count > 0 ? ` (${item.count} gasto${item.count > 1 ? 's' : ''})` : ' (Sin gastos)';
    this.updateProjectionCard(`${labelText}${countText}`, formatMoney(item.value));
  }

  updateProjectionCard(label, value) {
    if (!this.projectionCard) return;
    this.projectionCard.innerHTML = `
      <span class="projection-label">${label}</span>
      <span class="projection-value">${value}</span>
    `;
  }

  formatCompactNumber(num) {
    if (num >= 1000) {
      return (num / 1000).toFixed(num % 1000 === 0 ? 0 : 1) + 'k';
    }
    return Math.round(num);
  }
}
