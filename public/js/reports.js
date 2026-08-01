// Renders the Reports page charts from the analytics service payload.
(function () {
  const report = window.CASHFLOW_REPORT;
  if (!report || typeof Chart === "undefined") {
    return;
  }

  const money = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: report.currency || "USD"
  });

  // Whole-dollar ticks keep the axes readable at narrow widths.
  const moneyTick = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: report.currency || "USD",
    maximumFractionDigits: 0
  });

  // Palette validated for CVD separation and contrast on the white card.
  const INCOME = "#2a78d6";
  const EXPENSES = "#e34948";
  const GRID = "#dfe9e2";
  const INK_MUTED = "#5d6b62";

  Chart.defaults.font.family = "'Manrope', system-ui, sans-serif";
  Chart.defaults.color = INK_MUTED;

  const monthName = (key) => {
    const [year, month] = key.split("-").map(Number);
    return new Date(year, month - 1, 1).toLocaleDateString("en-US", {
      month: "short"
    });
  };

  const trendCanvas = document.getElementById("trendChart");
  if (trendCanvas) {
    new Chart(trendCanvas, {
      type: "line",
      data: {
        labels: report.monthly_trend.map((row) => monthName(row.month)),
        datasets: [
          {
            label: "Income",
            data: report.monthly_trend.map((row) => row.income),
            borderColor: INCOME,
            backgroundColor: INCOME,
            borderWidth: 2,
            pointRadius: 3,
            pointHitRadius: 10,
            tension: 0.3
          },
          {
            label: "Expenses",
            data: report.monthly_trend.map((row) => row.expenses),
            borderColor: EXPENSES,
            backgroundColor: EXPENSES,
            borderWidth: 2,
            pointRadius: 3,
            pointHitRadius: 10,
            tension: 0.3
          }
        ]
      },
      options: {
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { position: "bottom", labels: { boxWidth: 12, boxHeight: 12 } },
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.dataset.label}: ${money.format(ctx.parsed.y)}`
            }
          }
        },
        scales: {
          x: { grid: { display: false }, border: { color: GRID } },
          y: {
            beginAtZero: true,
            grid: { color: GRID },
            border: { display: false },
            ticks: {
              maxTicksLimit: 6,
              callback: (value) => moneyTick.format(value)
            }
          }
        }
      }
    });
  }

  const categoryCanvas = document.getElementById("categoryChart");
  if (categoryCanvas) {
    new Chart(categoryCanvas, {
      type: "bar",
      data: {
        labels: report.by_category.map((row) => `${row.icon} ${row.category}`),
        datasets: [
          {
            data: report.by_category.map((row) => row.total),
            backgroundColor: INCOME,
            borderRadius: 4,
            maxBarThickness: 22
          }
        ]
      },
      options: {
        indexAxis: "y",
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const row = report.by_category[ctx.dataIndex];
                return `${money.format(row.total)} (${row.share}%)`;
              }
            }
          }
        },
        scales: {
          x: {
            beginAtZero: true,
            grid: { color: GRID },
            border: { display: false },
            ticks: {
              maxTicksLimit: 5,
              callback: (value) => moneyTick.format(value)
            }
          },
          y: { grid: { display: false }, border: { color: GRID } }
        }
      }
    });
  }
})();
