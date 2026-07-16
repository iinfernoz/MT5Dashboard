import os
import pymysql
import json
from datetime import datetime
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
                            if 'open_price' in t and t['open_price'] is not None:
                                t['open_price'] = cents_to_usd(t['open_price'])
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

            # Calculate total weekly profit
            cursor.execute(sql_periodic, (start_of_week,))
            weekly_result = cursor.fetchone()
            total_weekly_profit = weekly_result['period_profit'] if weekly_result and weekly_result['period_profit'] is not None else 0

            # Calculate total monthly profit
            cursor.execute(sql_periodic, (start_of_month,))
            monthly_result = cursor.fetchone()
            total_monthly_profit = monthly_result['period_profit'] if monthly_result and monthly_result['period_profit'] is not None else 0

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
        # This query sums the equity of all accounts for each timestamp.
        # It groups data into 5-minute intervals to reduce the number of data points.
        sql = """
            SELECT
                -- Group timestamps into 5-minute intervals
                FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(received_at) / 300) * 300) AS time_interval,
                SUM(equity) AS total_equity
            FROM
                account_data
            WHERE
                received_at >= NOW() - INTERVAL 7 DAY -- Limit to last 7 days for performance
            GROUP BY
                time_interval
            ORDER BY
                time_interval;
        """
        with conn.cursor() as cursor:
            cursor.execute(sql)
            history = cursor.fetchall()
        return jsonify(history), 200
    except Exception as e:
        print(f"Equity History Error: {e}")
        return jsonify({"status": "error", "message": "Failed to retrieve equity history"}), 500
    finally:
        if conn:
            conn.close()
