# -*- coding: utf-8 -*-
# ТОЛЬКО дедуп по имени. Ничего не удаляет по диапазонам id.
# Запускать НА СЕРВЕРЕ из ~/ttalem:  python3 dedupe_only.py
import json, shutil, datetime, collections

DB_PATH = "data/db.json"
backup_path = f"data/db.json.backup-{datetime.datetime.now():%Y%m%d_%H%M%S}"
shutil.copy(DB_PATH, backup_path)
print("Бэкап сохранён:", backup_path)

with open(DB_PATH, encoding="utf-8") as f:
    db = json.load(f)

print("Продуктов до дедупа:", len(db["products"]))

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
    new_stock[remap.get(pid, pid)] = v
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

# проверка целостности: все ли productId в recipe существуют
existing_ids = {p["id"] for p in db["products"]}
broken = []
for p in db["products"]:
    for item in p.get("recipe", []):
        if item.get("productId") not in existing_ids:
            broken.append((p["name"], item["productId"]))
if broken:
    print("!!! БИТЫЕ ССЫЛКИ в рецептах:", broken)
else:
    print("Ссылки в рецептах целые, битых нет.")

with open(DB_PATH, "w", encoding="utf-8") as f:
    json.dump(db, f, ensure_ascii=False, indent=2)

print(f"ИТОГО продуктов в базе: {len(db['products'])}")
