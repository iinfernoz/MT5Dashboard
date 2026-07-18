import os
import pymysql
import json
import requests
from datetime import datetime, timedelta, timezone
from flask import Flask, request, jsonify

app = Flask(__name__)

# --- Database Connection Details from Environment Variables ---
DB_HOST = os.environ.get('DB_HOST')
DB_USER = os.environ.get('DB_USER')
DB_PASSWORD = os.environ.get('DB_PASSWORD')
DB_NAME = os.environ.get('DB_NAME')


def get_db_connection():
    """Establishes and returns a new database connection."""
    try:
        connection = pymysql.connect(
            host=DB_HOST,
            user=DB_USER,
            password=DB_PASSWORD,
            database=DB_NAME,
            cursorclass=pymysql.cursors.DictCursor,
            connect_timeout=10
        )
        return connection
    except pymysql.MySQLError as e:
        print(f"Error while connecting to MySQL: {e}")
        return None


# --- Economic calendar cache settings ---
CACHE_FILE = os.path.join(os.path.dirname(__file__), 'ff_calendar_cache.json')
CACHE_TTL_SECONDS = 3600  # 1 hour
FF_CALENDAR_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json'


def _read_cache_file():
    if not os.path.exists(CACHE_FILE):
        return None
    try:
        with open(CACHE_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return None


def _write_cache_file(payload):
    try:
        with open(CACHE_FILE, 'w', encoding='utf-8') as f:
            json.dump(payload, f)
    except Exception as e:
        print(f"Failed to write cache file: {e}")


def _is_cache_fresh(cached):
    if not cached or 'fetched_at' not in cached:
        return False
    try:
        fetched = datetime.fromisoformat(cached['fetched_at'])
    except Exception:
        return False
    return (datetime.utcnow() - fetched) < timedelta(seconds=CACHE_TTL_SECONDS)


def _fetch_remote_calendar():
    try:
        resp = requests.get(FF_CALENDAR_URL, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        payload = {'fetched_at': datetime.utcnow().isoformat(), 'raw': data}
        _write_cache_file(payload)
        return payload
    except Exception as e:
        print(f"Failed to fetch remote calendar: {e}")
        return None


def _get_calendar_payload():
    # Try cache first
    cached = _read_cache_file()
    if _is_cache_fresh(cached):
        return cached, True

    # Cache is stale or missing; try to fetch remote
    remote = _fetch_remote_calendar()
    if remote:
        return remote, False

    # If remote failed but we have any cached data, return stale cache
    if cached:
        return cached, True

    # Nothing available
    return {'fetched_at': None, 'raw': []}, True


def _filter_today_high_usd(raw_list):
    # Backwards-compatible: keep the original function behavior
    today = datetime.utcnow().date().isoformat()
    filtered = []
    for ev in raw_list:
        try:
            impact = ev.get('impact') or ev.get('importance') or ev.get('impact_level')
            if isinstance(impact, str) and impact.lower() != 'high':
                continue

                # Keep all countries; only filter by High impact

            is_today = False
            for k in ('date', 'date_str', 'time', 'datetime', 'local_date'):
                v = ev.get(k)
                if isinstance(v, str) and v.startswith(today):
                    is_today = True
                    break
            if not is_today and 'timestamp' in ev:
                try:
                    ts = int(ev.get('timestamp'))
                    if datetime.utcfromtimestamp(ts).date().isoformat() == today:
                        is_today = True
                except Exception:
                    pass

            if not is_today:
                continue

            filtered.append(ev)
        except Exception:
            continue
    return filtered


def _group_week_events_by_date(raw_list):
    """Return a dict mapping ISO date -> list of all events for that date."""
    def _get_event_date_iso(ev):
        """
        Parses an event's date/time string and returns the ISO date (YYYY-MM-DD)
        corresponding to the event's occurrence in Thailand's timezone (UTC+7).
        """
        thailand_tz = timezone(timedelta(hours=7))

        for k in ('date', 'datetime', 'time', 'local_date', 'date_str'):
            v = ev.get(k)
            if not isinstance(v, str):
                continue

            # Prioritize parsing full ISO 8601 timestamps, as they are most accurate.
            try:
                dt_aware = datetime.fromisoformat(v.replace('Z', '+00:00'))
                dt_thailand = dt_aware.astimezone(thailand_tz)
                return dt_thailand.date().isoformat()
            except (ValueError, TypeError):
                # If parsing fails, it's not a standard ISO string, so we continue.
                pass

        # Fallback for integer timestamp (assumed to be UTC)
        if 'timestamp' in ev:
            try:
                ts = int(ev.get('timestamp'))
                dt_utc = datetime.fromtimestamp(ts, tz=timezone.utc)
                dt_thailand = dt_utc.astimezone(thailand_tz)
                return dt_thailand.date().isoformat()
            except (ValueError, TypeError):
                pass
        return None

    grouped = {}
    for ev in raw_list:
        try:
            # Filter for Medium and High impact events only
            impact_val = ev.get('impact') or ev.get('importance') or ev.get('impact_level')
            if not impact_val or not isinstance(impact_val, str):
                continue  # Skip events without a valid impact rating

            if impact_val.lower() not in ['medium', 'high']:
                continue  # Skip low-impact and other events

            date_iso = _get_event_date_iso(ev)
            if not date_iso:
                continue

            grouped.setdefault(date_iso, []).append(ev)
        except Exception:
            continue

    sorted_grouped = {k: grouped[k] for k in sorted(grouped.keys())}
    return sorted_grouped


def ensure_table_exists(conn):
    """
    Ensures the 'account_data' table exists and has all required columns.
    """
    with conn.cursor() as cursor:
        # Create table if it doesn't exist
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS `account_data` (
              `id` INT AUTO_INCREMENT PRIMARY KEY,
              `account_name` VARCHAR(100) NOT NULL,
              `magic_number` BIGINT,
              `balance` DECIMAL(12, 2),
              `equity` DECIMAL(12, 2),
              `profit` DECIMAL(12, 2), -- This is daily profit from MT5
              `ea_server_time` DATETIME,
              `received_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              INDEX(account_name),
              INDEX(ea_server_time)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        """)
        # Check for 'floating_pl' column and add it if it doesn't exist for backward compatibility
        cursor.execute("""
            SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = %s AND TABLE_NAME = 'account_data' AND COLUMN_NAME = 'floating_pl'
        """, (DB_NAME,))
        if cursor.fetchone()['COUNT(*)'] == 0:
            cursor.execute("ALTER TABLE `account_data` ADD COLUMN `floating_pl` DECIMAL(12, 2) DEFAULT 0.00;")
        # Check for 'account_number'
        cursor.execute("""
            SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = %s AND TABLE_NAME = 'account_data' AND COLUMN_NAME = 'account_number'
        """, (DB_NAME,))
        if cursor.fetchone()['COUNT(*)'] == 0:
            cursor.execute("ALTER TABLE `account_data` ADD COLUMN `account_number` BIGINT AFTER `id`;")
        # Check for 'broker_name'
        cursor.execute("""
            SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = %s AND TABLE_NAME = 'account_data' AND COLUMN_NAME = 'broker_name'
        """, (DB_NAME,))
        if cursor.fetchone()['COUNT(*)'] == 0:
            cursor.execute("ALTER TABLE `account_data` ADD COLUMN `broker_name` VARCHAR(100) AFTER `account_name`;")
        # Check for index on account_number for performance
        cursor.execute("""
            SELECT COUNT(*) FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = %s AND TABLE_NAME = 'account_data' AND INDEX_NAME = 'idx_account_number'
        """, (DB_NAME,))
        if cursor.fetchone()['COUNT(*)'] == 0 and cursor.execute("SHOW COLUMNS FROM `account_data` LIKE 'account_number';"):
            # Only add index if the column exists
            cursor.execute("ALTER TABLE `account_data` ADD INDEX `idx_account_number` (`account_number`);")
        # Check for 'open_trades' column
        cursor.execute("""
            SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = %s AND TABLE_NAME = 'account_data' AND COLUMN_NAME = 'open_trades'
        """, (DB_NAME,))
        if cursor.fetchone()['COUNT(*)'] == 0:
            # Using JSON type is efficient for storing structured data like trade lists
            cursor.execute("ALTER TABLE `account_data` ADD COLUMN `open_trades` JSON;")
    conn.commit()


@app.route('/api/update', methods=['POST'])
def update_ea_data():
    """Endpoint to receive and store data from a MetaTrader EA."""
    if not request.is_json:
        return jsonify({"status": "error", "message": "Request must be JSON"}), 400

    data = request.get_json()

    # Add 'open_trades' to the list of required fields
    required_fields = ['account_number', 'account_name', 'broker_name', 'magic_number', 'balance', 'equity', 'profit', 'floating_pl', 'open_trades']
    missing_fields = [field for field in required_fields if field not in data]
    if missing_fields:
        return jsonify({"status": "error", "message": f"Missing required fields: {missing_fields}"}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({"status": "error", "message": "Could not connect to the database"}), 503

    try:
        ensure_table_exists(conn)

        sql = """
            INSERT INTO account_data
            (account_number, account_name, broker_name, magic_number, balance, equity, profit, floating_pl, open_trades, ea_server_time)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """
        with conn.cursor() as cursor:
            cursor.execute(sql, (
                data.get('account_number'),
                data.get('account_name'),
                data.get('broker_name'),
                data.get('magic_number'),
                data.get('balance'),
                data.get('equity'),
                data.get('profit'),
                data.get('floating_pl'),
                json.dumps(data.get('open_trades')), # A more direct way to get a JSON string
                datetime.utcnow(),
            ))
        conn.commit()
        return jsonify({"status": "success", "message": "Data saved"}), 201
    except pymysql.MySQLError as e:
        print(f"Database Error: {e}")
        return jsonify({"status": "error", "message": "Database operation failed"}), 500
    finally:
        if conn:
            conn.close()


@app.route('/health', methods=['GET'])
def health_check():
    """A simple health check endpoint to verify that the API is running."""
    return jsonify({"status": "ok", "message": "API is running"}), 200


@app.route('/api/economic-events', methods=['GET'])
def economic_events():
    """Returns today's High-impact USD events using a 1-hour cached payload."""
    try:
        payload, from_cache = _get_calendar_payload()
        raw = payload.get('raw') if payload else []
        # Some feeds are objects with a top-level list under a key, try to handle both
        if isinstance(raw, dict):
            # pick the first list-like value
            lists = [v for v in raw.values() if isinstance(v, list)]
            raw_list = lists[0] if lists else []
        elif isinstance(raw, list):
            raw_list = raw
        else:
            raw_list = []

        # Group events by date (only days that have events)
        events_by_date = _group_week_events_by_date(raw_list)

        # Build a full Monday-Sunday week range containing today
        today = datetime.utcnow().date()
        start_of_week = today - timedelta(days=today.weekday())  # Monday
        week_dates = [(start_of_week + timedelta(days=i)).isoformat() for i in range(7)]

        # Ensure every day in the week is present (empty list when no events)
        events_by_date_full = {d: events_by_date.get(d, []) for d in week_dates}

        return jsonify({
            'source': 'cache' if from_cache else 'remote',
            'fetched_at': payload.get('fetched_at'),
            'dates': week_dates,
            'events_by_date': events_by_date_full
        }), 200
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/api/dashboard', methods=['GET'])
def get_dashboard_data():
    """
    Retrieves the latest data entry for each unique account name
    and calculates overall summary statistics.
    """
    from datetime import datetime, timedelta, timezone
    conn = get_db_connection()
    if not conn:
        return jsonify({"status": "error", "message": "Could not connect to the database"}), 503

    try:
        # Ensure the table schema is up-to-date before reading from it.
        ensure_table_exists(conn)

        # This SQL query finds the row with the highest 'id' for each 'account_name'.
        # This is an efficient way to get the latest record for each account.
        sql = """
            SELECT a.*
            FROM account_data a
            INNER JOIN (
                SELECT account_number, MAX(id) as max_id
                FROM account_data
                GROUP BY account_number
            ) b ON a.account_number = b.account_number AND a.id = b.max_id
            ORDER BY a.account_number;
        """
        # Use a single cursor context for all database operations in this function
        with conn.cursor() as cursor:
            cursor.execute(sql)
            accounts = cursor.fetchall()

            # The 'open_trades' column is stored as a JSON string.
            # We need to parse it back into a Python list before sending it to the frontend.
            for acc in accounts:
                trades_str = acc.get('open_trades')
                if trades_str and isinstance(trades_str, str):
                    try:
                        acc['open_trades'] = json.loads(trades_str)
                    except json.JSONDecodeError:
                        acc['open_trades'] = [] # If JSON is malformed, default to empty list
                elif not trades_str:
                    acc['open_trades'] = [] # If it's None/NULL, default to empty list

            # --- Convert amounts from cents to USD for display ---
            def cents_to_usd(v):
                try:
                    if v is None:
                        return 0.0
                    return float(v) / 100.0
                except Exception:
                    return 0.0

            for acc in accounts:
                # Convert top-level numeric fields
                acc['balance'] = cents_to_usd(acc.get('balance'))
                acc['equity'] = cents_to_usd(acc.get('equity'))
                acc['profit'] = cents_to_usd(acc.get('profit'))
                acc['floating_pl'] = cents_to_usd(acc.get('floating_pl', 0))

                # Convert values inside open_trades if present
                if isinstance(acc.get('open_trades'), list):
                    for t in acc['open_trades']:
                        if isinstance(t, dict):
                            if 'profit' in t and t['profit'] is not None:
                                t['profit'] = cents_to_usd(t['profit'])
                            # NOTE: 'open_price' is already in USD (price), do not convert from cents.
            if not accounts:
                return jsonify({
                    "summary": {
                        "total_balance": 0, "total_equity": 0, "total_floating_pl": 0,
                        "daily_profit": 0, "weekly_profit": 0, "monthly_profit": 0,
                        "account_count": 0
                    },
                    "accounts": []
                }), 200

            # --- Calculate Summary Stats (values are already in USD) ---
            total_balance = sum(acc.get('balance', 0) or 0 for acc in accounts)
            total_equity = sum(acc.get('equity', 0) or 0 for acc in accounts)
            total_daily_profit = sum(acc.get('profit', 0) or 0 for acc in accounts)
            total_floating_pl = sum(acc.get('floating_pl', 0) or 0 for acc in accounts)

            # --- Calculate Weekly & Monthly Profit ---
            now = datetime.utcnow() # Use naive UTC datetime to match database
            start_of_week = (now - timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
            start_of_month = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

            sql_periodic = """
                WITH DailyFinalProfits AS (
                    -- For each account and each day, find the last recorded profit value.
                    -- Since the EA sends a running total for the day, the MAX is the final realized profit for that day.
                    SELECT
                        MAX(profit) as final_daily_profit
                    FROM
                        account_data
                    WHERE
                        received_at >= %s
                    GROUP BY
                        DATE(received_at), account_number
                )
                -- Sum up the final daily profits for all accounts and all days in the period
                SELECT SUM(final_daily_profit) as period_profit FROM DailyFinalProfits;
            """

            # Calculate total weekly profit (DB stores cents — convert to USD)
            cursor.execute(sql_periodic, (start_of_week,))
            weekly_result = cursor.fetchone()
            try:
                weekly_cents = weekly_result['period_profit'] if weekly_result and weekly_result['period_profit'] is not None else 0
                total_weekly_profit = float(weekly_cents) / 100.0
            except Exception:
                total_weekly_profit = 0

            # Calculate total monthly profit (DB stores cents — convert to USD)
            cursor.execute(sql_periodic, (start_of_month,))
            monthly_result = cursor.fetchone()
            try:
                monthly_cents = monthly_result['period_profit'] if monthly_result and monthly_result['period_profit'] is not None else 0
                total_monthly_profit = float(monthly_cents) / 100.0
            except Exception:
                total_monthly_profit = 0

            response_data = {
                "summary": {
                    "total_balance": total_balance,
                    "total_equity": total_equity,
                    "total_floating_pl": total_floating_pl,
                    "daily_profit": total_daily_profit,
                    "weekly_profit": total_weekly_profit,
                    "monthly_profit": total_monthly_profit,
                    "account_count": len(accounts)
                },
                "accounts": [{**acc, 'last_update': acc['ea_server_time']} for acc in accounts]
            }
            return jsonify(response_data), 200
    except pymysql.MySQLError as e:
        # This handles cases where the table might not exist yet
        if e.args[0] == 1146: # Error code for "Table doesn't exist"
            return jsonify({"summary": {
                "total_balance": 0, "total_equity": 0, "total_floating_pl": 0,
                "daily_profit": 0, "weekly_profit": 0, "monthly_profit": 0,
                "account_count": 0
            }, "accounts": []}), 200
        print(f"Dashboard Database Error: {e}")
        return jsonify({"status": "error", "message": "Dashboard query failed"}), 500
    finally:
        if conn:
            conn.close()


@app.route('/api/equity_history', methods=['GET'])
def get_equity_history():
    """
    Retrieves aggregated equity history for the dashboard chart.
    To keep the payload small, it samples the data.
    """
    conn = get_db_connection()
    if not conn:
        return jsonify({"status": "error", "message": "Could not connect to the database"}), 503

    try:
        # This query builds the total equity curve using the latest account snapshot
        # inside each 5-minute interval. It avoids double-counting multiple updates
        # from the same account within the same bucket.
        sql = """
            SELECT
                time_interval,
                SUM(equity) AS total_equity
            FROM (
                SELECT
                    FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(a.received_at) / 300) * 300) AS time_interval,
                    a.account_number,
                    a.equity
                FROM account_data a
                JOIN (
                    SELECT
                        account_number,
                        FLOOR(UNIX_TIMESTAMP(received_at) / 300) AS interval_bucket,
                        MAX(received_at) AS max_received_at
                    FROM account_data
                    WHERE received_at >= NOW() - INTERVAL 7 DAY
                    GROUP BY account_number, interval_bucket
                ) b ON a.account_number = b.account_number
                    AND FLOOR(UNIX_TIMESTAMP(a.received_at) / 300) = b.interval_bucket
                    AND a.received_at = b.max_received_at
                WHERE a.received_at >= NOW() - INTERVAL 7 DAY
            ) t
            GROUP BY time_interval
            ORDER BY time_interval;
        """
        with conn.cursor() as cursor:
            cursor.execute(sql)
            history = cursor.fetchall()

        # Convert stored cent values to USD for the chart.
        for row in history:
            total_equity = row.get('total_equity')
            row['total_equity'] = float(total_equity) / 100.0 if total_equity is not None else 0.0

        return jsonify(history), 200
    except Exception as e:
        print(f"Equity History Error: {e}")
        return jsonify({"status": "error", "message": "Failed to retrieve equity history"}), 500
    finally:
        if conn:
            conn.close()


@app.route('/api/admin/reset_daily_profit', methods=['POST'])
def reset_daily_profit():
    """
    Admin endpoint to reset the daily profit for a specific account on a specific date.
    This is useful for correcting erroneous profit data.
    Expects JSON payload: {"account_number": 12345, "date": "YYYY-MM-DD"}
    """
    if not request.is_json:
        return jsonify({"status": "error", "message": "Request must be JSON"}), 400

    data = request.get_json()
    account_number = data.get('account_number')
    date_str = data.get('date')

    if not account_number or not date_str:
        return jsonify({"status": "error", "message": "Missing 'account_number' or 'date'"}), 400

    try:
        # Validate date format
        reset_date = datetime.strptime(date_str, '%Y-%m-%d').date()
    except ValueError:
        return jsonify({"status": "error", "message": "Invalid date format. Use YYYY-MM-DD."}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({"status": "error", "message": "Could not connect to the database"}), 503

    try:
        sql = "UPDATE account_data SET profit = 0 WHERE account_number = %s AND DATE(received_at) = %s"
        with conn.cursor() as cursor:
            rows_affected = cursor.execute(sql, (account_number, reset_date))
        conn.commit()
        return jsonify({
            "status": "success",
            "message": f"Reset profit to 0 for account {account_number} on {reset_date}. {rows_affected} records updated."
        }), 200
    except pymysql.MySQLError as e:
        print(f"Database Error during profit reset: {e}")
        return jsonify({"status": "error", "message": "Database operation failed"}), 500
    finally:
        if conn:
            conn.close()


@app.route('/api/monthly_profit_details', methods=['GET'])
def get_monthly_profit_details():
    """
    Retrieves daily profit breakdown for a given month.
    Query parameters:
      - year: int (default: current year)
      - month: int (default: current month, 1-12)
    
    Returns a dict with daily profit data and metadata about the month.
    """
    conn = get_db_connection()
    if not conn:
        return jsonify({"status": "error", "message": "Could not connect to the database"}), 503

    try:
        ensure_table_exists(conn)
        
        # Parse query parameters
        year = request.args.get('year', default=datetime.utcnow().year, type=int)
        month = request.args.get('month', default=datetime.utcnow().month, type=int)
        
        # Validate month
        if month < 1 or month > 12:
            month = datetime.utcnow().month
        if year < 1:
            year = datetime.utcnow().year
        
        # Calculate start and end of month
        start_of_month = datetime(year, month, 1, 0, 0, 0, 0)
        if month == 12:
            end_of_month = datetime(year + 1, 1, 1, 0, 0, 0, 0) - timedelta(seconds=1)
        else:
            end_of_month = datetime(year, month + 1, 1, 0, 0, 0, 0) - timedelta(seconds=1)
        
        # Query daily profits for each day in the month
        sql = """
            SELECT
                DATE(received_at) AS profit_date,
                MAX(profit) AS final_daily_profit
            FROM account_data
            WHERE received_at >= %s AND received_at <= %s
            GROUP BY DATE(received_at), account_number
            ORDER BY DATE(received_at);
        """
        
        with conn.cursor() as cursor:
            cursor.execute(sql, (start_of_month, end_of_month))
            daily_records = cursor.fetchall()
        
        # Aggregate daily profits by date (sum across all accounts)
        daily_profits = {}
        for record in daily_records:
            date_str = record['profit_date'].isoformat() if record['profit_date'] else None
            if date_str:
                profit_cents = record['final_daily_profit']
                profit_usd = float(profit_cents) / 100.0 if profit_cents is not None else 0.0
                
                if date_str in daily_profits:
                    daily_profits[date_str] += profit_usd
                else:
                    daily_profits[date_str] = profit_usd
        
        # Calculate total monthly profit
        total_monthly = sum(daily_profits.values())
        
        # Build calendar data with all days in month
        import calendar
        cal = calendar.monthcalendar(year, month)
        
        # Prepare calendar data for frontend
        calendar_data = []
        for week in cal:
            for day_num in week:
                if day_num == 0:  # Days from other months
                    continue
                date_obj = datetime(year, month, day_num).date()
                date_iso = date_obj.isoformat()
                profit = daily_profits.get(date_iso, 0.0)
                day_name = date_obj.strftime('%a')  # Mon, Tue, etc.
                
                calendar_data.append({
                    'day': day_num,
                    'date': date_iso,
                    'profit': profit,
                    'day_name': day_name
                })
        
        # Get available months from data
        sql_months = """
            SELECT DISTINCT YEAR(received_at) as yr, MONTH(received_at) as mth
            FROM account_data
            ORDER BY yr DESC, mth DESC
            LIMIT 24;
        """
        
        with conn.cursor() as cursor:
            cursor.execute(sql_months)
            available_months = cursor.fetchall()
        
        available_months_list = [
            {'year': m['yr'], 'month': m['mth']} 
            for m in available_months
        ]
        
        return jsonify({
            'year': year,
            'month': month,
            'month_name': datetime(year, month, 1).strftime('%B %Y'),
            'total_profit': total_monthly,
            'calendar': calendar_data,
            'available_months': available_months_list
        }), 200
        
    except Exception as e:
        print(f"Monthly Profit Details Error: {e}")
        return jsonify({"status": "error", "message": "Failed to retrieve monthly profit details"}), 500
    finally:
        if conn:
            conn.close()
