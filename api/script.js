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
    // New element IDs for the redesigned economic events section
    const eventsListTabsEl = document.getElementById('events-list-tabs');
    const eventsListHeaderEl = document.getElementById('events-list-header');
    const eventsListContentEl = document.getElementById('events-list-content');

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
    let collapsedGroups = {}; // For new economic events UI
    let lastEventsPayload = null; // Cache last payload for re-renders

    // Use event delegation for economic event tabs for efficiency and reliability.
    // This listener is attached once to the container.
    if (eventsListTabsEl) {
        eventsListTabsEl.addEventListener('click', (ev) => {
            // Find the button that was clicked
            const btn = ev.target.closest('.day-tab');
            if (!btn || !btn.dataset.date) return;

            const date = btn.dataset.date;
            // If the same date is clicked again, do nothing.
            if (date === selectedEventDate) return;

            // Update the state
            selectedEventDate = date;
            collapsedGroups = {}; // Reset collapse state on date change

            // Re-render the component using the last fetched data
            if (lastEventsPayload) {
                renderEconomicEvents(lastEventsPayload);
            }
        });
    }

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
            updateStatus('connected', `Last updated: ${new Date().toLocaleTimeString()}`);

        } catch (error) {
            console.error("Failed to fetch data:", error);
            updateStatus('error', 'Failed to load data');
        }
    }

    async function initialLoad() {
        await fetchData();
        await fetchEquityHistory();
        await fetchEconomicEvents();
    }


    async function fetchEconomicEvents() {
        if (!eventsListContentEl) return;
        try {
            const resp = await fetch(ECON_EVENTS_URL);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const body = await resp.json();
            lastEventsPayload = body; // Cache the payload
            renderEconomicEvents(body);
        } catch (err) {
            console.error('Failed to fetch economic events:', err);
            if (eventsListContentEl) eventsListContentEl.innerHTML = '<p style="padding:12px;">Unable to load events.</p>';
        }
    }

    function toggleTimeGroup(groupKey) {
        collapsedGroups[groupKey] = !collapsedGroups[groupKey];
        if (lastEventsPayload) {
            renderEconomicEvents(lastEventsPayload);
        }
    }

    function toggleAllTimeGroups(expand) {
        if (!lastEventsPayload || !selectedEventDate) return;

        const rawData = (lastEventsPayload.events_by_date || {})[selectedEventDate] || [];
        const groupKeys = new Set();

        rawData.forEach(event => {
            let parsedTime = null;
            const timeCandidates = [event.date, event.datetime, event.time, event.local_date];
            for (const t of timeCandidates) {
                if (!t) continue;
                const d = new Date(t);
                if (!isNaN(d.getTime())) { parsedTime = d; break; }
            }
            if (!parsedTime && event.timestamp) {
                const ts = Number(event.timestamp);
                if (!isNaN(ts)) parsedTime = new Date(ts * 1000);
            }
            const time = parsedTime ? new Intl.DateTimeFormat('th-TH', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Bangkok' }).format(parsedTime) : 'N/A';
            const country = event.country || event.currency || event.country_iso || 'N/A';
            groupKeys.add(`${time}_${country}`);
        });

        groupKeys.forEach(key => {
            collapsedGroups[key] = !expand;
        });

        renderEconomicEvents(lastEventsPayload);
    }

    window.toggleTimeGroup = toggleTimeGroup;
    window.toggleAllTimeGroups = toggleAllTimeGroups;

    // This function is completely rewritten to support the new timeline design.
    function renderEconomicEvents(payload) {
        if (!eventsListContentEl || !eventsListTabsEl || !eventsListHeaderEl) return;

        const dates = Array.isArray(payload.dates) ? payload.dates : [];
        const byDate = payload.events_by_date || {};

        if (!dates || dates.length === 0) {
            eventsListContentEl.innerHTML = '<p class="text-gray-300">ยังไม่มีข่าวสำคัญในสัปดาห์นี้</p>';
            return;
        }

        const todayIso = new Date().toISOString().slice(0, 10);

        // Determine active date
        if (!selectedEventDate || !dates.includes(selectedEventDate)) {
            selectedEventDate = dates.includes(todayIso) ? todayIso : dates[0];
        }

        // 1. Render Date Navigation Tabs
        let tabsHtml = '<div class="flex items-center gap-1 overflow-x-auto pb-1.5 scrollbar-none" id="date-slider">';
        dates.forEach(d => {
            const dateObj = new Date(d);
            const isToday = d === todayIso;
            const isActive = d === selectedEventDate;

            const weekday = dateObj.toLocaleDateString('th-TH', { weekday: 'short' });
            const datePart = dateObj.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });
            let displayLabel = `${weekday} ${datePart}`;
            if (isToday) {
                displayLabel += ' (วันนี้)';
            }
            const activeClass = isActive ? "bg-blue-600 hover:bg-blue-700 text-white shadow-lg shadow-blue-500/25 border-blue-500" : "bg-slate-900/60 hover:bg-slate-800 text-slate-300 border-slate-800/80 hover:text-white";
            const indicatorDot = isToday ? `<span class="absolute top-1 right-1.5 w-1 h-1 rounded-full bg-[#3b82f6]"></span>` : "";
            tabsHtml += `<button class="day-tab relative flex-shrink-0 px-3 py-1.5 rounded-lg text-[11px] font-semibold border transition-all duration-200 ${activeClass}" data-date="${d}">${displayLabel} ${indicatorDot}</button>`;
        });
        tabsHtml += '</div>';
        eventsListTabsEl.innerHTML = tabsHtml;

        // 2. Render Header for the selected date
        const currentDateLabel = new Date(selectedEventDate).toLocaleDateString('th-TH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        let headerHtml = `
            <h3 class="font-bold text-sm md:text-base text-slate-200 flex items-center gap-1.5">
                📅 ${currentDateLabel}
            </h3>
            <div class="flex gap-2">
                <button onclick="toggleAllTimeGroups(false)" class="text-[10px] bg-slate-900 border border-slate-800 text-slate-400 hover:text-white px-2 py-1 rounded-md transition duration-200 flex items-center gap-1">
                    <i class="fa-solid fa-compress text-[8px]"></i> ยุบทั้งหมด
                </button>
                <button onclick="toggleAllTimeGroups(true)" class="text-[10px] bg-slate-900 border border-slate-800 text-slate-400 hover:text-white px-2 py-1 rounded-md transition duration-200 flex items-center gap-1">
                    <i class="fa-solid fa-expand text-[8px]"></i> ขยายทั้งหมด
                </button>
            </div>
        `;
        eventsListHeaderEl.innerHTML = headerHtml;

        // 3. Render Content for the selected date
        const list = byDate[selectedEventDate] || [];
        if (list.length === 0) {
            eventsListContentEl.innerHTML = `
                <div class="flex flex-col items-center justify-center py-8 px-4 border border-dashed border-slate-800 rounded-xl text-center text-slate-500">
                    <i class="fa-solid fa-calendar-minus text-2xl mb-2 text-slate-600"></i>
                    <p class="text-xs font-semibold">ไม่พบข้อมูลข่าวสำหรับวันนี้</p>
                </div>
            `;
            return;
        }

        // Group events by time and country
        const groups = {};
        list.forEach(event => {
            let parsedTime = null;
            const timeCandidates = [event.date, event.datetime, event.time, event.local_date];
            for (const t of timeCandidates) {
                if (!t) continue;
                const d = new Date(t);
                if (!isNaN(d.getTime())) { parsedTime = d; break; }
            }
            if (!parsedTime && event.timestamp) {
                const ts = Number(event.timestamp);
                if (!isNaN(ts)) parsedTime = new Date(ts * 1000);
            }
            const time = parsedTime ? new Intl.DateTimeFormat('th-TH', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Bangkok' }).format(parsedTime) : 'N/A';
            const country = event.country || event.currency || event.country_iso || 'N/A';
            const groupKey = `${time}_${country}`;
            if (!groups[groupKey]) {
                groups[groupKey] = { time, country, key: groupKey, events: [] };
            }
            groups[groupKey].events.push(event);
        });

        const groupKeys = Object.keys(groups).sort((a, b) => a.split('_')[0].localeCompare(b.split('_')[0]));
        let contentHtml = '';

        groupKeys.forEach((key, index) => {
            const group = groups[key];
            const isLast = index === groupKeys.length - 1;
            const isCollapsed = collapsedGroups[group.key] || false;

            const timelineMarkup = `
                <div class="flex flex-col items-center">
                    <button onclick="toggleTimeGroup('${group.key}')" title="คลิกเพื่อยุบ/ขยายกลุ่มเวลานี้" class="w-10 h-10 rounded-xl bg-slate-900 border ${isCollapsed ? 'border-amber-500/40 bg-amber-950/10' : 'border-slate-800 hover:border-blue-500/50'} flex flex-col items-center justify-center shadow-md relative z-10 transition-all duration-200">
                        <span class="text-xs font-bold text-blue-400 font-mono">${group.time}</span>
                        ${isCollapsed ? '<span class="text-[7px] text-amber-500 font-bold leading-none -mt-0.5">ย่ออยู่</span>' : ''}
                    </button>
                    <div class="timeline-connector ${isLast ? 'timeline-connector-last' : ''}"></div>
                </div>
            `;

            let peakImpact = "MEDIUM";
            if (group.events.some(e => (e.impact || e.importance || '').toUpperCase() === "HIGH")) {
                peakImpact = "HIGH";
            }
            let badgeStyle = "bg-amber-500/10 text-amber-400 border-amber-500/20";
            if (peakImpact === "HIGH") {
                badgeStyle = "bg-red-500/10 text-red-400 border-red-500/20";
            }

            const toggleIcon = isCollapsed ? 'fa-square-plus text-amber-400' : 'fa-square-minus text-slate-500 hover:text-slate-300';
            const countryHeader = `
                <div class="flex items-center justify-between mb-1 flex-wrap gap-1">
                    <div class="flex items-center gap-1.5">
                        <div class="bg-slate-900 border border-slate-800 px-2 py-0.5 rounded text-[10px] font-bold text-slate-300 tracking-wider">${group.country}</div>
                        <span class="text-[9px] px-1.5 py-0.5 rounded font-bold tracking-wider border ${badgeStyle}">${peakImpact}</span>
                        <span class="text-[10px] text-slate-500 font-mono">(${group.events.length} ข่าว)</span>
                    </div>
                    <button onclick="toggleTimeGroup('${group.key}')" class="text-xs focus:outline-none px-1 py-0.5 rounded hover:bg-slate-800/40" title="ยุบ/ขยาย"><i class="fa-solid ${toggleIcon} transition-all duration-200"></i></button>
                </div>
            `;

            let eventsBoxContent = "";
            if (!isCollapsed) {
                group.events.forEach(event => {
                    const title = event.title || event.event || event.name || 'Untitled';
                    const isCore = title.toLowerCase().includes("core");
                    eventsBoxContent += `
                        <div class="grid grid-cols-12 items-center gap-1.5 py-1.5 border-b border-slate-800/30 last:border-0 hover:bg-slate-800/20 rounded px-1.5 -mx-1.5 transition-all">
                            <div class="col-span-12 flex items-center gap-2">
                                <span class="text-blue-500/70 text-[6px]"><i class="fa-solid fa-circle"></i></span>
                                <div class="leading-tight">
                                    <span class="text-xs font-semibold text-slate-200">${title}</span>
                                    ${isCore ? '<span class="ml-1 text-[8px] bg-amber-500/10 text-amber-400 border border-amber-500/20 px-1 py-0.5 rounded font-bold uppercase">Core</span>' : ''}
                                </div>
                            </div>
                        </div>
                    `;
                });
            } else {
                const titleSnippets = group.events.map(e => e.title || e.event || e.name).join(', ');
                eventsBoxContent = `<div onclick="toggleTimeGroup('${group.key}')" class="py-1 text-[10px] text-slate-500 italic cursor-pointer hover:text-slate-300 truncate"><i class="fa-solid fa-eye-slash mr-1"></i> ยุบอยู่: ${titleSnippets}</div>`;
            }

            const groupDetails = `
                <div class="flex-grow pb-2">
                    ${countryHeader}
                    <div class="bg-gradient-to-b from-[#111827] to-[#0a0f1d] border border-slate-800/80 rounded-xl px-3 py-1.5 shadow-md">
                        <div class="divide-y divide-slate-800/30">${eventsBoxContent}</div>
                    </div>
                </div>
            `;
            contentHtml += `<div class="relative flex gap-3 md:gap-4 group transition-all duration-200 mb-1.5">${timelineMarkup}${groupDetails}</div>`;
        });

        eventsListContentEl.innerHTML = contentHtml;

        // Event listeners are now handled by delegation, so this block is no longer needed.
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
    initialLoad();

    // Set interval to refresh data
    setInterval(fetchData, REFRESH_INTERVAL);
    setInterval(fetchEquityHistory, REFRESH_INTERVAL * 4); // Refresh chart every minute
    // Refresh economic events every 5 minutes
    setInterval(fetchEconomicEvents, 300000);
});