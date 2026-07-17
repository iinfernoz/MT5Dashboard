# Monthly Profit Calendar - Debugging Guide

## Issue
The monthly profit calendar modal doesn't open when clicking on the "Monthly Profit" card.

## Debugging Steps

1. **Open Browser Console** (F12 or Right-click → Inspect → Console tab)

2. **Look for these console messages after clicking**:
   - `monthlyProfitCard: <div>...` (element found)
   - `monthlyProfitModal: <div>...` (element found)
   - `calendarDaysContainer: <div>...` (element found)
   - If any shows `null`, that element wasn't found

3. **When you click the "Click to view calendar" text**, you should see:
   - An alert saying "Monthly calendar button clicked!"
   - Console log: "openMonthlyProfitModal called"
   - Console log: "Modal display set to block"
   - API request URL and response

## What We Added

### Backend (app.py)
- New endpoint: `/api/monthly_profit_details?year=YYYY&month=MM`
- Returns daily profit data for the specified month

### Frontend (index.html)
- Clickable "Monthly Profit" card with ID `monthly-profit-card`
- Modal with ID `monthly-profit-modal`
- Calendar grid container with ID `calendar-days`

### Styling (style.css)
- Calendar modal styles with gradient backgrounds
- Day cells with profit/loss indicators
- Navigation buttons for month switching

### Functionality (script.js)
- Event listener to open modal on card click
- API call to fetch daily profit data
- Calendar rendering with color-coded days
- Previous/Next month navigation

## Common Issues & Solutions

### Issue: Alert doesn't appear
**Possible Cause**: Click event listener not attached
**Solution**: Check browser console for error messages

### Issue: Modal appears but is blank
**Possible Cause**: API endpoint returning error
**Solution**: Check Network tab → look for `/api/monthly_profit_details` response

### Issue: "Cannot read property 'style' of null"
**Possible Cause**: monthlyProfitModal element not found
**Solution**: Verify HTML ID matches: `id="monthly-profit-modal"`

## Testing Instructions

1. Open http://localhost:7010 in your browser
2. Open browser DevTools (F12)
3. Go to Console tab
4. Click on the "Monthly Profit" card
5. Watch for console messages and check if alert appears
6. Check Network tab to see API response
7. Share the console output with us for further debugging
