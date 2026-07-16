document.addEventListener('DOMContentLoaded', () => {
    const API_URL = '/api/dashboard'; // Proxied through Nginx
    const REFRESH_INTERVAL = 15000; // 15 seconds

    const statusIndicator = document.getElementById('status-indicator');
    const statusText = document.getElementById('status-text');

    const totalBalanceEl = document.getElementById('total-balance');
    const totalEquityEl = document.getElementById('total-equity');
    const totalFloatingPlEl = document.getElementById('total-floating-pl');
    const accountCountEl = document.getElementById('account-count');
    const dailyProfitEl = document.getElementById('daily-profit');
    const weeklyProfitEl = document.getElementById('weekly-profit');
    const monthlyProfitEl = document.getElementById('monthly-profit');

    const accountsTableContainer = document.getElementById('accounts-table-container');
    const equityChartCanvas = document.getElementById('equity-chart');
    let equityChart = null;
    const EQUITY_HISTORY_URL = '/api/equity_history';

    // Modal elements
    const modal = document.getElementById('details-modal');
    const modalAccountNameEl = document.getElementById('modal-account-name');
    const modalBodyEl = document.getElementById('modal-body');
    const closeButton = document.querySelector('.close-button');
    let currentAccountsData = []; // Store current data to use for the modal

    function formatCurrency(value) {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'USD'
        }).format(value);
    }

    function formatProfit(value) {
        const formatted = formatCurrency(value);
        return value >= 0 ? `+${formatted}` : formatted;
    }

    function updateStatus(state, message) {
        statusIndicator.className = `status-dot ${state}`;
        statusText.textContent = message;
    }

    async function fetchData() {
        try {
            const response = await fetch(API_URL);

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            currentAccountsData = data.accounts; // Save the latest account data
            updateDashboard(data);
            await fetchEquityHistory();
            updateStatus('connected', `Last updated: ${new Date().toLocaleTimeString()}`);

        } catch (error) {
            console.error("Failed to fetch data:", error);
            updateStatus('error', 'Failed to load data');
        }
    }

    function updateDashboard(data) {
        // Update summary cards
        totalBalanceEl.textContent = formatCurrency(data.summary.total_balance);
        totalEquityEl.textContent = formatCurrency(data.summary.total_equity);
        totalFloatingPlEl.textContent = formatCurrency(data.summary.total_floating_pl);
        accountCountEl.textContent = data.summary.account_count;

        dailyProfitEl.textContent = formatProfit(data.summary.daily_profit);
        weeklyProfitEl.textContent = formatProfit(data.summary.weekly_profit);
        monthlyProfitEl.textContent = formatProfit(data.summary.monthly_profit);

        // Update accounts table
        renderTable(data.accounts);
    }

    async function fetchEquityHistory() {
        try {
            const response = await fetch(EQUITY_HISTORY_URL);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const history = await response.json();
            renderEquityChart(history);
        } catch (error) {
            console.error('Failed to fetch equity history:', error);
            if (equityChart) {
                equityChart.data.labels = [];
                equityChart.data.datasets[0].data = [];
                equityChart.update();
            }
        }
    }

    function renderEquityChart(history) {
        if (!Array.isArray(history) || history.length === 0) {
            console.warn('Equity history is empty or invalid');
            if (equityChart) {
                equityChart.data.datasets[0].data = [];
                equityChart.update();
            }
            return;
        }

        const dataPoints = history.map(point => {
            const timeValue = new Date(point.time_interval).getTime();
            return {
                x: Number.isFinite(timeValue) ? timeValue : null,
                y: Number(point.total_equity) || 0
            };
        }).filter(point => point.x !== null);

        if (dataPoints.length === 0) {
            console.warn('Equity history points could not be parsed');
            if (equityChart) {
                equityChart.data.datasets[0].data = [];
                equityChart.update();
            }
            return;
        }

        if (!equityChart) {
            equityChart = new Chart(equityChartCanvas, {
                type: 'line',
                data: {
                    datasets: [{
                        label: 'Total Equity',
                        data: dataPoints,
                        borderColor: 'rgba(56, 189, 248, 0.92)',
                        backgroundColor: 'rgba(56, 189, 248, 0.18)',
                        fill: true,
                        tension: 0.24,
                        pointRadius: 0,
                        borderWidth: 2,
                        hoverRadius: 4,
                        hoverBorderWidth: 2,
                        spanGaps: true,
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    interaction: {
                        mode: 'index',
                        intersect: false,
                    },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                label: context => `Equity: ${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(context.parsed.y)}`
                            }
                        }
                    },
                    scales: {
                        x: {
                            type: 'time',
                            time: {
                                unit: 'day',
                                tooltipFormat: 'PP',
                            },
                            grid: {
                                color: 'rgba(148, 163, 184, 0.18)'
                            },
                            ticks: {
                                color: 'rgba(226, 232, 240, 0.8)'
                            }
                        },
                        y: {
                            grid: {
                                color: 'rgba(148, 163, 184, 0.18)'
                            },
                            ticks: {
                                color: 'rgba(226, 232, 240, 0.8)',
                                callback: value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value)
                            }
                        }
                    }
                }
            });
        } else {
            equityChart.data.datasets[0].data = dataPoints;
            equityChart.update();
        }
    }

    function renderTable(accounts) {
        if (accounts.length === 0) {
            accountsTableContainer.innerHTML = '<p style="text-align:center; padding: 20px;">No account data received yet.</p>';
            return;
        }

        let tableHTML = `
            <table>
                <thead>
                    <tr>
                        <th>Status</th>
                        <th>Account</th>
                        <th>Balance</th>
                        <th>Equity</th>
                        <th>Floating P/L</th>
                        <th>Daily Profit</th>
                        <th>Last Update</th>
                    </tr>
                </thead>
                <tbody>
        `;

        accounts.forEach(acc => {
            const dailyProfitClass = acc.profit >= 0 ? 'profit-positive' : 'profit-negative';
            const floatingPlClass = (acc.floating_pl || 0) >= 0 ? 'profit-positive' : 'profit-negative';

            const lastUpdate = new Date(acc.last_update);
            const lastUpdateThai = isNaN(lastUpdate) ? 'N/A' : lastUpdate.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', hour12: false });
            const now = new Date();
            const minutesDiff = isNaN(lastUpdate) ? Infinity : (now - lastUpdate) / 1000 / 60;
            const statusClass = minutesDiff > 5 ? 'status-offline' : 'status-online';
            const statusText = minutesDiff > 5 ? 'Offline' : 'Online';

            tableHTML += `
                <tr class="clickable-row" data-account-number="${acc.account_number}">
                    <td data-label="Status"><span class="status-dot ${statusClass}"></span><span class="status-label">${statusText}</span></td>
                    <td data-label="Account">
                        <div class="account-cell">
                            <span class="account-name">${acc.account_name || 'N/A'}</span>
                            <span class="account-number">#${acc.account_number || 'N/A'}</span>
                        </div>
                    </td>
                    <td data-label="Balance"><span class="currency-cell">${formatCurrency(acc.balance)}</span></td>
                    <td data-label="Equity"><span class="currency-cell">${formatCurrency(acc.equity)}</span></td>
                    <td data-label="Floating P/L"><span class="profit-pill ${floatingPlClass}">${formatCurrency(acc.floating_pl || 0)}</span></td>
                    <td data-label="Daily Profit"><span class="profit-pill ${dailyProfitClass}">${formatProfit(acc.profit || 0)}</span></td>
                    <td data-label="Last Update" class="time-cell">${lastUpdateThai}</td>
                </tr>
            `;
        });

        tableHTML += `
                </tbody>
            </table>
        `;

        accountsTableContainer.innerHTML = tableHTML;
        addTableClickListeners();
    }

    function addTableClickListeners() {
        document.querySelectorAll('.clickable-row').forEach(row => {
            row.addEventListener('click', () => {
                const accountNumber = row.dataset.accountNumber;
                const accountData = currentAccountsData.find(acc => acc.account_number == accountNumber);
                if (accountData) {
                    showModal(accountData);
                }
            });
        });
    }

    function showModal(account) {
        modalAccountNameEl.textContent = `${account.account_name} (${account.account_number})`;
        
        // For now, we'll just show the same data in a different format.
        // This is where you would add more details like open trades in the future.
        modalBodyEl.innerHTML = `
            <p><strong>Broker:</strong> ${account.broker_name}</p>
            <p><strong>Balance:</strong> ${formatCurrency(account.balance)}</p>
            <p><strong>Equity:</strong> ${formatCurrency(account.equity)}</p>
            <p><strong>Floating P/L:</strong> <span class="${(account.floating_pl || 0) >= 0 ? 'profit-positive' : 'profit-negative'}">${formatCurrency(account.floating_pl || 0)}</span></p>
            <p><strong>Daily Profit:</strong> <span class="${(account.profit || 0) >= 0 ? 'profit-positive' : 'profit-negative'}">${formatProfit(account.profit || 0)}</span></p>
            <hr>
            <h4>Open Trades (${account.open_trades ? account.open_trades.length : 0})</h4>
            <div class="trades-table-container">
                ${generateTradesTable(account.open_trades)}
            </div>
        `;

        modal.style.display = 'block';
    }

    function generateTradesTable(trades) {
        if (!trades || trades.length === 0) {
            return '<p>No open trades.</p>';
        }

        let table = `
            <table class="trades-table">
                <thead>
                    <tr>
                        <th>Symbol</th>
                        <th>Type</th>
                        <th>Volume</th>
                        <th>Open Price</th>
                        <th>Profit</th>
                    </tr>
                </thead>
                <tbody>
        `;
        trades.forEach(trade => {
            const typeText = trade.type === 0 ? 'Buy' : 'Sell';
            const typeClass = trade.type === 0 ? 'trade-buy' : 'trade-sell';
            const profitClass = trade.profit >= 0 ? 'profit-positive' : 'profit-negative';
            table += `
                <tr>
                    <td>${trade.symbol}</td>
                    <td class="${typeClass}">${typeText}</td>
                    <td>${trade.volume.toFixed(2)}</td>
                    <td>${trade.open_price.toFixed(2)}</td>
                    <td class="${profitClass}">${formatCurrency(trade.profit)}</td>
                </tr>
            `;
        });
        table += '</tbody></table>';
        return table;
    }

    function closeModal() {
        modal.style.display = 'none';
    }

    // --- Event Listeners for Modal ---
    closeButton.addEventListener('click', closeModal);
    window.addEventListener('click', (event) => {
        if (event.target == modal) {
            closeModal();
        }
    });

    // --- Initial Load ---
    fetchData();

    // Set interval to refresh data
    setInterval(fetchData, REFRESH_INTERVAL);
});