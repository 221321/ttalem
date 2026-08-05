# -*- coding: utf-8 -*-
# 1) Удаляет старую линейку сэндвичей (продукты из исходного набора e5dc4aa)
#    вместе со связанными stock/operations/orders.
# 2) Убирает дубли новых рецептур (накладные+рационы), оставляя младший id.
# Запускать НА СЕРВЕРЕ из ~/ttalem:  python3 remove_sandwiches_and_dedupe.py
import json, shutil, datetime, collections

DB_PATH = "data/db.json"
backup_path = f"data/db.json.backup-{datetime.datetime.now():%Y%m%d_%H%M%S}"
shutil.copy(DB_PATH, backup_path)
print("Бэкап сохранён:", backup_path)

with open(DB_PATH, encoding="utf-8") as f:
    db = json.load(f)

# исходные id сэндвич-линейки (из первого коммита e5dc4aa)
SANDWICH_IDS = {f"p{i:03d}" for i in range(1, 56)} | {"p7d3qy", "p89mpj", "padnox"}

removed_names = [p["name"] for p in db["products"] if p["id"] in SANDWICH_IDS]
print(f"Удаляю сэндвич-линейку: {len(removed_names)} позиций ->", removed_names[:5], "...")

db["products"] = [p for p in db["products"] if p["id"] not in SANDWICH_IDS]

# чистим сиротские stock
removed_stock = [pid for pid in db.get("stock", {}) if pid in SANDWICH_IDS]
for pid in removed_stock:
    del db["stock"][pid]
print("Удалено остатков по сэндвич-товарам:", removed_stock)

# чистим operations/orders, ссылающиеся на удалённые id
before_ops = len(db.get("operations", []))
db["operations"] = [op for op in db.get("operations", []) if op.get("productId") not in SANDWICH_IDS]
before_orders = len(db.get("orders", []))
removed_orders = [o for o in db.get("orders", []) if o.get("productId") in SANDWICH_IDS]
db["orders"] = [o for o in db.get("orders", []) if o.get("productId") not in SANDWICH_IDS]
print(f"Удалено operations: {before_ops - len(db['operations'])}, orders: {before_orders - len(db['orders'])}", removed_orders)

# --- дедуп новых рецептур (как раньше) ---
by_name = collections.defaultdict(list)
for p in db["products"]:
    by_name[p["name"]].append(p)

def id_num(pid):
    digits = "".join(ch for ch in pid[1:] if ch.isdigit())
    return int(digits) if digits and digits == pid[1:] else 10**9

remap = {}
to_remove = set()
for name, plist in by_name.items():
    if len(plist) <= 1:
        continue
    plist_sorted = sorted(plist, key=lambda p: id_num(p["id"]))
    keep = plist_sorted[0]
    drops = plist_sorted[1:]
    for d in drops:
        remap[d["id"]] = keep["id"]
        to_remove.add(d["id"])
    print(f"дубль {name}: оставляю {keep['id']}, удаляю {[d['id'] for d in drops]}")

for p in db["products"]:
    for item in p.get("recipe", []):
        if item.get("productId") in remap:
            item["productId"] = remap[item["productId"]]

new_stock = {}
for pid, v in db.get("stock", {}).items():
    new_pid = remap.get(pid, pid)
    new_stock[new_pid] = v
db["stock"] = new_stock

for op in db.get("operations", []):
    if op.get("productId") in remap:
        op["productId"] = remap[op["productId"]]
for order in db.get("orders", []):
    if order.get("productId") in remap:
        order["productId"] = remap[order["productId"]]

before = len(db["products"])
db["products"] = [p for p in db["products"] if p["id"] not in to_remove]
after = len(db["products"])
print(f"Удалено дублей: {before - after}")

with open(DB_PATH, "w", encoding="utf-8") as f:
    json.dump(db, f, ensure_ascii=False, indent=2)

print(f"ИТОГО продуктов в базе: {len(db['products'])}")
