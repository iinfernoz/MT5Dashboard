//+------------------------------------------------------------------+
//|                                       DashboardConnectorEA.mq5 |
//|                        Copyright 2024, Gemini Code Assist        |
//|                                      https://gemini.google.com |
//+------------------------------------------------------------------+
#property copyright "Copyright 2024, Gemini Code Assist"
#property link      "https://gemini.google.com"
#property version   "1.30"
#property description "An Expert Advisor to send account data to a web dashboard."

//--- Input Parameters สำหรับให้ผู้ใช้ตั้งค่าตอนลาก EA ใส่กราฟ
input group "Dashboard Settings"
input string InpApiEndpoint = "https://mt5api.batnass.synology.me/api/update"; // << สำคัญ: แก้ไขเป็น URL ของ API ของคุณ
input string InpAccountName = "My Main Account"; // ชื่อบัญชีสำหรับแสดงบน Dashboard
input ulong  InpMagicNumber = 0; // Magic Number ของ EA (ถ้าไม่ใช้ใส่ 0)
input int    InpUpdateIntervalSeconds = 60; // อัปเดตข้อมูลทุกๆกี่วินาที (แนะนำ 60-300)

//+------------------------------------------------------------------+
//| Expert initialization function - ทำงานครั้งเดียวเมื่อ EA เริ่ม   |
//+------------------------------------------------------------------+
int OnInit()
{
   //--- ตั้งเวลาเพื่อให้ OnTimer() ทำงานตามช่วงเวลาที่กำหนด
   EventSetTimer(InpUpdateIntervalSeconds);
   
   Print("Dashboard Connector EA initialized. Data will be sent every ", InpUpdateIntervalSeconds, " seconds.");
   
   //--- ส่งข้อมูลทันที 1 ครั้งเมื่อ EA เริ่มทำงาน
   SendUpdateToServer();
   
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert deinitialization function - ทำงานเมื่อ EA ถูกเอาออก      |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   //--- หยุดการทำงานของ Timer
   EventKillTimer();
   Print("Dashboard Connector EA removed.");
}

//+------------------------------------------------------------------+
//| Timer function - ฟังก์ชันนี้จะถูกเรียกซ้ำๆ ตามเวลาที่ตั้งไว้      |
//+------------------------------------------------------------------+
void OnTimer()
{
   //--- เรียกฟังก์ชันสำหรับส่งข้อมูล
   SendUpdateToServer();
}

//+------------------------------------------------------------------+
//| Function to calculate REALIZED profit from today's closed trades |
//+------------------------------------------------------------------+
double GetRealizedDailyProfit()
{
   //--- กำหนดช่วงเวลาของวันนี้โดยใช้เวลาท้องถิ่น (Local Time) ของเครื่องผู้ใช้
   MqlDateTime st;
   TimeLocal(st); // ใช้เวลาท้องถิ่นเพื่อกำหนด "วันนี้"
   st.hour = 0;
   st.min = 0;
   st.sec = 0;
   datetime from_date = StructToTime(st); // เวลาเที่ยงคืนตามเวลาท้องถิ่น
   datetime to_date = TimeCurrent();     // เวลาปัจจุบันของเซิร์ฟเวอร์ (เพื่อให้ได้ deal ล่าสุด)

   //--- เลือกประวัติการเทรดในช่วงเวลาที่กำหนด
   if(!HistorySelect(from_date, to_date))
   {
      Print("HistorySelect for daily profit failed. Error: ", GetLastError());
      return 0.0;
   }

   double realized_profit = 0.0;
   ulong deal_ticket;
   int total_deals = HistoryDealsTotal();

   //--- วนลูปดูทุก deal ที่เกิดขึ้นในวันนี้
   for(int i = 0; i < total_deals; i++)
   {
      if((deal_ticket = HistoryDealGetTicket(i)) > 0)
      {
         //--- [IMPROVEMENT] ถ้ามีการระบุ Magic Number ให้กรองเฉพาะ deal ของ Magic Number นั้น
         //    ถ้า InpMagicNumber เป็น 0 จะนับรวมทุก deal
         if(InpMagicNumber != 0)
         {
            if(HistoryDealGetInteger(deal_ticket, DEAL_MAGIC) != InpMagicNumber)
               continue; // ข้าม deal ที่มี magic number ไม่ตรงกัน
         }

         long deal_type = HistoryDealGetInteger(deal_ticket, DEAL_TYPE);

         if(deal_type == DEAL_TYPE_BUY || deal_type == DEAL_TYPE_SELL)
         {
            realized_profit += HistoryDealGetDouble(deal_ticket, DEAL_PROFIT);
         }
      }
   }
   return realized_profit;
}

//+------------------------------------------------------------------+
//| Function to get all open trades as a JSON array string           |
//+------------------------------------------------------------------+
string GetOpenTradesAsJson()
{
   string json_array = "[";
   int total_positions = PositionsTotal();

   for(int i = 0; i < total_positions; i++)
   {
      //--- ดึงข้อมูลของแต่ละไม้
      ulong  ticket      = PositionGetTicket(i);
      string symbol      = PositionGetString(POSITION_SYMBOL);
      long   type        = PositionGetInteger(POSITION_TYPE); // 0: Buy, 1: Sell
      double volume      = PositionGetDouble(POSITION_VOLUME);
      double open_price  = PositionGetDouble(POSITION_PRICE_OPEN);
      double current_price = PositionGetDouble(POSITION_PRICE_CURRENT);
      double profit      = PositionGetDouble(POSITION_PROFIT);
      datetime time_open = (datetime)PositionGetInteger(POSITION_TIME);

      //--- สร้าง JSON object สำหรับไม้นี้
      string trade_json = StringFormat(
         "{\"ticket\":%d, \"symbol\":\"%s\", \"type\":%d, \"volume\":%.2f, \"open_price\":%.5f, \"profit\":%.2f}",
         ticket,
         symbol,
         type,
         volume,
         open_price,
         profit
      );

      //--- เพิ่มเข้าไปใน Array
      json_array += trade_json;
      if(i < total_positions - 1)
      {
         json_array += ","; // เพิ่มคอมม่าคั่นระหว่าง object
      }
   }

   json_array += "]";
   return json_array;
}

//+------------------------------------------------------------------+
//| Function to gather data and send it to the server                |
//+------------------------------------------------------------------+
void SendUpdateToServer()
{
   //--- 1. รวบรวมข้อมูลบัญชีที่จำเป็นทั้งหมด
   long   accountNumber = AccountInfoInteger(ACCOUNT_LOGIN);
   string brokerName    = AccountInfoString(ACCOUNT_COMPANY);
   double balance       = AccountInfoDouble(ACCOUNT_BALANCE);
   double equity        = AccountInfoDouble(ACCOUNT_EQUITY);
   double dailyProfit   = GetRealizedDailyProfit(); // << เรียกใช้ฟังก์ชันใหม่ที่แม่นยำกว่า
   
   //--- 2. คำนวณกำไร/ขาดทุนของไม้ที่เปิดค้างอยู่ (Floating P/L)
   double floatingPL = equity - balance;
   
   //--- 3. ดึงข้อมูลไม้ที่เปิดอยู่ทั้งหมดในรูปแบบ JSON
   string open_trades_json = GetOpenTradesAsJson();

   //--- 3. สร้างข้อมูล JSON ที่จะส่งไปยัง API
   //    ชื่อฟิลด์ ("account_number", "balance", etc.) ต้องตรงกับที่ Backend (app.py) คาดหวัง
   string json = StringFormat("{ \"account_number\": %d, "
                              "\"account_name\": \"%s\", "
                              "\"broker_name\": \"%s\", "
                              "\"magic_number\": %d, "
                              "\"balance\": %.2f, "
                              "\"equity\": %.2f, "
                              "\"profit\": %.2f, "
                              "\"floating_pl\": %.2f, "
                              "\"open_trades\": %s, " // <<< เพิ่มฟิลด์นี้
                              "\"server_time\": \"%s\" }", 
                              accountNumber,
                              InpAccountName,
                              brokerName,
                              InpMagicNumber,
                              balance,
                              equity,
                              dailyProfit,
                              floatingPL,
                              open_trades_json, // <<< ส่งข้อมูลไม้ที่เปิดอยู่
                              TimeToString(TimeCurrent(), TIME_DATE|TIME_SECONDS)
                             );

   //--- 4. เตรียมตัวสำหรับส่ง WebRequest
   char   post_data[], response_data[];
   string headers = "Content-Type: application/json\r\n"; // บอก Server ว่าเรากำลังส่งข้อมูลรูปแบบ JSON
   int    timeout = 10000; // รอการตอบกลับไม่เกิน 10 วินาที

   //--- แปลง JSON string เป็น char array สำหรับฟังก์ชัน WebRequest
   StringToCharArray(json, post_data, 0, StringLen(json), CP_UTF8);

   //--- 5. ส่งข้อมูลแบบ POST ไปยัง API
   ResetLastError(); // ล้างค่า Error เก่าก่อนเรียกฟังก์ชัน
   int res = WebRequest("POST", InpApiEndpoint, headers, timeout, post_data, response_data, headers);

   //--- 6. ตรวจสอบผลลัพธ์
   if(res == -1)
   {
      Print("WebRequest failed. Error code: ", GetLastError());
      // Error ที่พบบ่อย:
      // 4060: ฟังก์ชันไม่ได้รับอนุญาต -> ตรวจสอบว่าติ๊ก "Allow WebRequest" ใน Options แล้ว
      // 4014: URL ไม่อยู่ในรายการที่อนุญาต -> ตรวจสอบว่าเพิ่ม URL ถูกต้องแล้ว
   }
   else if (res == 201) // 201 Created คือรหัสที่ API ของเราส่งกลับมาเมื่อบันทึกข้อมูลสำเร็จ
   {
      Print("EA data sent successfully to dashboard API. Account: ", InpAccountName, ". Daily Profit sent: ", DoubleToString(dailyProfit, 2));
   }
   else
   {
      Print("API returned an unexpected status code: ", res);
      Print("Server response: ", CharArrayToString(response_data));
   }
}
//+------------------------------------------------------------------+
