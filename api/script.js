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
    const economicEventsContainer = document.getElementById('economic-events-container');
    const eventsListEl = document.getElementById('events-list');
    const eventsMetaEl = document.getElementById('economic-events-meta');
    const equityChartCanvas = document.getElementById('equity-chart');
    let equityChart = null;
    const EQUITY_HISTORY_URL = '/api/equity_history';
    const ECON_EVENTS_URL = '/api/economic-events';

    // Modal elements
    const modal = document.getElementById('details-modal');
    const modalAccountNameEl = document.getElementById('modal-account-name');
    const modalBodyEl = document.getElementById('modal-body');
    const closeButton = document.querySelector('.close-button');
    let currentAccountsData = []; // Store current data to use for the modal
    let selectedEventDate = null;

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
            await fetchEconomicEvents();
            updateStatus('connected', `Last updated: ${new Date().toLocaleTimeString()}`);

        } catch (error) {
            console.error("Failed to fetch data:", error);
            updateStatus('error', 'Failed to load data');
        }
    }

    async function fetchEconomicEvents() {
        if (!eventsListEl) return;
        try {
            const resp = await fetch(ECON_EVENTS_URL);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const body = await resp.json();
            renderEconomicEvents(body);
        } catch (err) {
            console.error('Failed to fetch economic events:', err);
            if (eventsListEl) eventsListEl.innerHTML = '<p style="padding:12px;">Unable to load events.</p>';
        }
    }

    function renderEconomicEvents(payload) {
        if (!eventsListEl) return;
        // Do not display source/fetched meta per UX request

        const dates = Array.isArray(payload.dates) ? payload.dates : [];
        const byDate = payload.events_by_date || {};

        if (!dates || dates.length === 0) {
            eventsListEl.innerHTML = '<p class="text-gray-300">ยังไม่มีข่าวสำคัญในสัปดาห์นี้</p>';
            return;
        }

        const todayIso = new Date().toISOString().slice(0, 10);

        // Determine active date: keep previously selected if still available, otherwise prefer today, else first date
        let activeDate = todayIso;
        if (selectedEventDate && Array.isArray(dates) && dates.includes(selectedEventDate)) {
            activeDate = selectedEventDate;
        } else if (Array.isArray(dates) && dates.includes(todayIso)) {
            activeDate = todayIso;
        } else if (Array.isArray(dates) && dates.length) {
            activeDate = dates[0];
        }

        // Tabs
        let tabsHtml = '<div class="flex space-x-2 overflow-x-auto pb-4 mb-4 border-b border-gray-800" id="dayTabs">';
        dates.forEach(d => {
            const isActive = d === activeDate;
            const label = (d === todayIso) ? 'วันนี้' : new Date(d).toLocaleDateString('th-TH', { day: '2-digit', month: 'short' });
            const btnClasses = isActive ? 'px-4 py-2 bg-indigo-600 text-white rounded-lg font-medium whitespace-nowrap transition-all' : 'px-4 py-2 bg-gray-800 text-gray-300 rounded-lg font-medium hover:bg-gray-700 whitespace-nowrap transition-all';
            tabsHtml += `<button class="day-tab ${btnClasses}" data-date="${d}">${label}</button>`;
        });
        tabsHtml += '</div>';

        // Content sections
        let contentHtml = '<div id="newsContainer">';
        dates.forEach(d => {
            const dateLabel = new Date(d).toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
            const list = Array.isArray(byDate[d]) ? byDate[d] : [];
            let inner = '';

            if (list.length === 0) {
                inner = '<p class="text-gray-400">ไม่มีข่าว</p>';
            } else {
                // Group events by time, country, and impact to match the requested table format
                const eventsByGroup = {};
                list.forEach(ev => {
                    let parsedTime = null;
                    const timeCandidates = [ev.date, ev.datetime, ev.time, ev.local_date];
                    for (const t of timeCandidates) {
                        if (!t) continue;
                        const d = new Date(t);
                        if (!isNaN(d.getTime())) {
                            parsedTime = d;
                            break;
                        }
                    }
                    if (!parsedTime && ev.timestamp) {
                        const ts = Number(ev.timestamp);
                        if (!isNaN(ts)) parsedTime = new Date(ts * 1000);
                    }
                    let time = 'N/A';
                    if (parsedTime) {
                        time = new Intl.DateTimeFormat('th-TH', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Bangkok' }).format(parsedTime);
                    }

                    const country = ev.country || ev.currency || ev.country_iso || 'N/A';
                    const impact = (ev.impact || ev.importance || ev.impact_level || 'LOW').toString().toUpperCase();
                    const title = ev.title || ev.event || ev.name || ev.description || 'Untitled';

                    const groupKey = `${time}-${country}-${impact}`;
                    if (!eventsByGroup[groupKey]) {
                        eventsByGroup[groupKey] = { time, country, impact, events: [] };
                    }
                    eventsByGroup[groupKey].events.push(title);
                });

                // Sort groups by time
                const sortedGroups = Object.values(eventsByGroup).sort((a, b) => a.time.localeCompare(b.time));

                inner = `
                    <table class="economic-events-table">
                        <thead>
                            <tr>
                                <th class="w-1/6">เวลา</th>
                                <th class="w-1/6">ประเทศ</th>
                                <th class="w-1/4">ระดับความรุนแรง</th>
                                <th>ข่าวสำคัญ</th>
                            </tr>
                        </thead>
                        <tbody>
                `;

                sortedGroups.forEach(group => {
                    let impactIcon = '⚪';
                    let impactBadgeClass = 'impact-badge-low';
                    if (group.impact === 'HIGH') {
                        impactIcon = '🔴';
                        impactBadgeClass = 'impact-badge-high';
                    } else if (group.impact === 'MEDIUM') {
                        impactIcon = '🟠';
                        impactBadgeClass = 'impact-badge-medium';
                    } else if (group.impact === 'LOW') {
                        impactIcon = '🟡';
                        impactBadgeClass = 'impact-badge-low';
                    }

                    const eventTitles = group.events.map(title => `• ${title}`).join('<br>');
                    const impactContent = `<span class="impact-badge ${impactBadgeClass}">${impactIcon} ${group.impact}</span>`;

                    inner += `
                        <tr>
                            <td data-label="เวลา" class="time-cell">${group.time}</td>
                            <td data-label="ประเทศ" class="country-cell">${group.country}</td>
                            <td data-label="ระดับความรุนแรง" class="impact-cell">${impactContent}</td>
                            <td data-label="ข่าวสำคัญ" class="event-title">${eventTitles}</td>
                        </tr>
                    `;
                });

                inner += '</tbody></table>';
            }
            const hiddenAttr = (d === activeDate) ? '' : ' hidden';
            contentHtml += `<section id="day-${d}" class="day-section${hiddenAttr}"><h2 class="text-lg font-semibold mb-4 text-indigo-400">📅 ${dateLabel}</h2>${inner}</section>`;
        });
        contentHtml += '</div>';

        eventsListEl.innerHTML = tabsHtml + contentHtml;

        // Wire up tab click behavior and persist selection
        document.querySelectorAll('.day-tab').forEach(btn => {
            btn.addEventListener('click', (ev) => {
                const btnEl = ev.currentTarget;
                const date = btnEl.dataset.date;

                // Save selection in-memory for auto refreshes
                selectedEventDate = date;

                document.querySelectorAll('.day-tab').forEach(b => {
                    b.classList.remove('bg-indigo-600', 'text-white');
                    b.classList.add('bg-gray-800', 'text-gray-300');
                });

                // Activate clicked
                btnEl.classList.add('bg-indigo-600', 'text-white');
                btnEl.classList.remove('bg-gray-800', 'text-gray-300');

                // Show/hide sections
                document.querySelectorAll('.day-section').forEach(sec => {
                    if (sec.id === `day-${date}`) {
                        sec.classList.remove('hidden');
                    } else {
                        sec.classList.add('hidden');
                    }
                });
            });
        });
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

        modal.style.display = 'flex';
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

    // --- Monthly Profit Calendar ---
    const monthlyProfitCard = document.getElementById('monthly-profit-card');
    const monthlyProfitModal = document.getElementById('monthly-profit-modal');
    const monthlyCloseBtn = document.querySelector('.monthly-close');
    const calendarMonthTitle = document.getElementById('calendar-month-title');
    const calendarTotalProfit = document.getElementById('calendar-total-profit');
    const calendarProfitDays = document.getElementById('calendar-profit-days');
    const calendarLossDays = document.getElementById('calendar-loss-days');
    const calendarDaysContainer = document.getElementById('calendar-days');
    const prevMonthBtn = document.getElementById('prev-month');
    const nextMonthBtn = document.getElementById('next-month');

    // Debug: Check if elements were found
    console.log('monthlyProfitCard:', monthlyProfitCard);
    console.log('monthlyProfitModal:', monthlyProfitModal);
    console.log('calendarDaysContainer:', calendarDaysContainer);
    
    if (monthlyProfitCard === null) {
        console.error('ERROR: monthlyProfitCard element was NOT found in the DOM!');
    }
    if (monthlyProfitModal === null) {
        console.error('ERROR: monthlyProfitModal element was NOT found in the DOM!');
    }

    let currentCalendarYear = new Date().getFullYear();
    let currentCalendarMonth = new Date().getMonth() + 1;
    let availableCalendarMonths = [];

    async function fetchMonthlyProfitDetails(year, month) {
        try {
            console.log(`Fetching monthly profit details for ${year}-${month}`);
            const url = `/api/monthly_profit_details?year=${year}&month=${month}`;
            console.log('Fetching from:', url);
            const response = await fetch(url);
            console.log('Response status:', response.status);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();
            console.log('Data received:', data);
            renderCalendar(data);
        } catch (error) {
            console.error('Failed to fetch monthly profit details:', error);
            if (calendarDaysContainer) {
                calendarDaysContainer.innerHTML = '<p style="grid-column: 1/-1; text-align: center;">Unable to load calendar data.</p>';
            }
        }
    }

    function updateCalendarNavButtons() {
        const now = new Date();
        // Disable 'Next' button if the current view is the current month or in the future.
        const isFutureOrCurrentMonth = (currentCalendarYear > now.getFullYear()) ||
                                     (currentCalendarYear === now.getFullYear() && currentCalendarMonth >= now.getMonth() + 1);
        if (nextMonthBtn) {
            nextMonthBtn.disabled = isFutureOrCurrentMonth;
            nextMonthBtn.style.opacity = isFutureOrCurrentMonth ? '0.5' : '1';
        }

        // Disable 'Previous' button if we are at or before the oldest month with data.
        let isAtOrBeforeOldest = false;
        if (availableCalendarMonths && availableCalendarMonths.length > 0) {
            const oldestMonth = availableCalendarMonths[availableCalendarMonths.length - 1];
            isAtOrBeforeOldest = (currentCalendarYear < oldestMonth.year) ||
                                 (currentCalendarYear === oldestMonth.year && currentCalendarMonth <= oldestMonth.month);
        } else {
            // If there's no history, disable going back.
            isAtOrBeforeOldest = true;
        }

        if (prevMonthBtn) {
            prevMonthBtn.disabled = isAtOrBeforeOldest;
            prevMonthBtn.style.opacity = isAtOrBeforeOldest ? '0.5' : '1';
        }
    }

    function renderCalendar(data) {
        console.log('renderCalendar called with data:', data);
        
        if (Array.isArray(data.available_months)) {
            availableCalendarMonths = data.available_months;
        }

        // Update header
        if (calendarMonthTitle) {
            calendarMonthTitle.textContent = data.month_name;
        }
        if (calendarTotalProfit) {
            calendarTotalProfit.textContent = formatProfit(data.total_profit);
            calendarTotalProfit.className = data.total_profit >= 0 ? 'stat-value' : 'stat-value loss';
        }

        // Calculate stats
        const profitDays = data.calendar.filter(day => day.profit > 0).length;
        const lossDays = data.calendar.filter(day => day.profit < 0).length;
        if (calendarProfitDays) {
            calendarProfitDays.textContent = profitDays;
        }
        if (calendarLossDays) {
            calendarLossDays.textContent = lossDays;
        }

        // Build calendar grid
        let calendarHtml = '';
        const firstDay = new Date(data.year, data.month - 1, 1).getDay();
        
        // Add empty cells for days before the month starts
        for (let i = 0; i < firstDay; i++) {
            calendarHtml += '<div class="calendar-day empty"></div>';
        }

        // Add day cells
        data.calendar.forEach(day => {
            const profitClass = day.profit > 0 ? 'profit' : day.profit < 0 ? 'loss' : 'empty';
            const profitDisplay = day.profit !== 0 ? formatProfit(day.profit) : '-';
            
            calendarHtml += `
                <div class="calendar-day ${profitClass}" title="${day.date}: ${profitDisplay}">
                    <div class="calendar-day-num">${day.day}</div>
                    <div class="calendar-day-profit">${profitDisplay}</div>
                </div>
            `;
        });

        if (calendarDaysContainer) {
            calendarDaysContainer.innerHTML = calendarHtml;
            console.log('Calendar rendered successfully');
        } else {
            console.error('calendarDaysContainer is null!');
        }

        updateCalendarNavButtons();
    }

    function openMonthlyProfitModal() {
        console.log('openMonthlyProfitModal called');
        if (monthlyProfitModal) {
            monthlyProfitModal.style.display = 'flex';
            console.log('Modal display set to block');
            fetchMonthlyProfitDetails(currentCalendarYear, currentCalendarMonth);
        } else {
            console.error('monthlyProfitModal is null!');
        }
    }

    function closeMonthlyProfitModal() {
        monthlyProfitModal.style.display = 'none';
    }

    function goToPreviousMonth() {
        if (currentCalendarMonth === 1) {
            currentCalendarMonth = 12;
            currentCalendarYear--;
        } else {
            currentCalendarMonth--;
        }
        fetchMonthlyProfitDetails(currentCalendarYear, currentCalendarMonth);
    }

    function goToNextMonth() {
        // The check for future months is now handled by disabling the button.
        if (currentCalendarMonth === 12) {
            currentCalendarMonth = 1;
            currentCalendarYear++;
        } else {
            currentCalendarMonth++;
        }
        fetchMonthlyProfitDetails(currentCalendarYear, currentCalendarMonth);
    }

    // Event listeners
    if (monthlyProfitCard) {
        monthlyProfitCard.addEventListener('click', openMonthlyProfitModal);
        console.log('Monthly profit card click listener attached');
    } else {
        console.error('monthlyProfitCard element not found!');
    }
    
    if (monthlyProfitModal) {
        const monthlyCloseButton = monthlyProfitModal.querySelector('.close-button');
        if (monthlyCloseButton) {
            monthlyCloseButton.addEventListener('click', closeMonthlyProfitModal);
            console.log('Monthly close button listener attached');
        } else {
            console.error('Monthly close button not found inside modal!');
        }
    } else {
        console.error('monthlyProfitModal element not found!');
    }
    
    if (prevMonthBtn) {
        prevMonthBtn.addEventListener('click', goToPreviousMonth);
    } else {
        console.error('prevMonthBtn element not found!');
    }
    
    if (nextMonthBtn) {
        nextMonthBtn.addEventListener('click', goToNextMonth);
    } else {
        console.error('nextMonthBtn element not found!');
    }

    window.addEventListener('click', (event) => {
        if (event.target === monthlyProfitModal) {
            closeMonthlyProfitModal();
        }
    });

    // --- Initial Load ---
    fetchData();

    // Set interval to refresh data
    setInterval(fetchData, REFRESH_INTERVAL);
    // Refresh economic events every 5 minutes
    setInterval(fetchEconomicEvents, 300000);
});