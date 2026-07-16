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
        statusIndicator.className = state;
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
                        <th>AccountNumber</th>
                        <th>Account Name</th>
                        <th>Broker Name</th>
                        <th>Balance</th>
                        <th>Equity</th>
                        <th>Floating P/L</th>
                        <th>Daily Profit</th>
                        <th>Last Update (Server)</th>
                    </tr>
                </thead>
                <tbody>
        `;

        accounts.forEach(acc => {
            const dailyProfitClass = acc.profit >= 0 ? 'profit-positive' : 'profit-negative';
            const floatingPlClass = (acc.floating_pl || 0) >= 0 ? 'profit-positive' : 'profit-negative';

            const lastUpdate = new Date(acc.last_update);
            const now = new Date();
            const minutesDiff = (now - lastUpdate) / 1000 / 60;
            const statusClass = minutesDiff > 5 ? 'status-offline' : 'status-online';
            const statusText = minutesDiff > 5 ? 'Offline' : 'Online';

            tableHTML += `
                <tr class="clickable-row" data-account-number="${acc.account_number}">
                    <td data-label="Status"><span class="status-dot ${statusClass}"></span>${statusText}</td>
                    <td data-label="Account Number">${acc.account_number || 'N/A'}</td>
                    <td data-label="Account Name">${acc.account_name || 'N/A'}</td>
                    <td data-label="Broker Name">${acc.broker_name || 'N/A'}</td>
                    <td data-label="Balance">${formatCurrency(acc.balance)}</td>
                    <td data-label="Equity">${formatCurrency(acc.equity)}</td>
                    <td data-label="Floating P/L" class="${floatingPlClass}">${formatCurrency(acc.floating_pl || 0)}</td>
                    <td data-label="Daily Profit" class="${dailyProfitClass}">${formatProfit(acc.profit || 0)}</td>
                    <td data-label="Last Update" class="time-cell">${new Date(acc.last_update).toLocaleString()}</td>
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