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
    # sourceId (полуфабрикат -> сырьё) тоже мог указывать на удаляемый дубль
    if p.get("sourceId") in remap:
        p["sourceId"] = remap[p["sourceId"]]

# остатки: если у обоих дублей были остатки на одном складе — СКЛАДЫВАЕМ,
# а не затираем один другим (склады хранятся как {skladId: {qty, value}})
new_stock = {}
for pid, v in db.get("stock", {}).items():
    target = remap.get(pid, pid)
    if target not in new_stock:
        new_stock[target] = v
    else:
        merged = dict(new_stock[target])
        for sk_id, sk_val in v.items():
            if sk_id in merged:
                merged[sk_id] = {
                    "qty": round(merged[sk_id].get("qty", 0) + sk_val.get("qty", 0), 4),
                    "value": round(merged[sk_id].get("value", 0) + sk_val.get("value", 0), 4),
                }
            else:
                merged[sk_id] = sk_val
        new_stock[target] = merged
        print(f"склеены остатки на складах для {target}: {list(v.keys())} присоединены к существующим")
db["stock"] = new_stock

for op in db.get("operations", []):
    if op.get("productId") in remap:
        op["productId"] = remap[op["productId"]]
    # накладные и акты списания хранят товары не в op.productId, а в op.items[]
    for item in op.get("items", []) or []:
        if item.get("productId") in remap:
            item["productId"] = remap[item["productId"]]
    # выпуск (production) хранит списанное сырьё в op.writeoffs[]
    for wo in op.get("writeoffs", []) or []:
        if wo.get("productId") in remap:
            wo["productId"] = remap[wo["productId"]]
    # обработка (processing) хранит сырьё/п-ф отдельными полями
    if op.get("rawId") in remap:
        op["rawId"] = remap[op["rawId"]]
    if op.get("semiId") in remap:
        op["semiId"] = remap[op["semiId"]]
for order in db.get("orders", []):
    if order.get("productId") in remap:
        order["productId"] = remap[order["productId"]]

before = len(db["products"])
db["products"] = [p for p in db["products"] if p["id"] not in to_remove]
after = len(db["products"])
print(f"Удалено дублей: {before - after}")

# проверка целостности: все ли productId в recipe и sourceId существуют
existing_ids = {p["id"] for p in db["products"]}
broken = []
for p in db["products"]:
    for item in p.get("recipe", []):
        if item.get("productId") not in existing_ids:
            broken.append((p["name"], "recipe", item["productId"]))
    if p.get("sourceId") and p["sourceId"] not in existing_ids:
        broken.append((p["name"], "sourceId", p["sourceId"]))
for op in db.get("operations", []):
    label = op.get("type", "?") + "|" + str(op.get("id", "?"))
    if op.get("productId") and op["productId"] not in existing_ids:
        broken.append((label, "productId", op["productId"]))
    for item in op.get("items", []) or []:
        if item.get("productId") and item["productId"] not in existing_ids:
            broken.append((label, "items.productId", item["productId"]))
    for wo in op.get("writeoffs", []) or []:
        if wo.get("productId") and wo["productId"] not in existing_ids:
            broken.append((label, "writeoffs.productId", wo["productId"]))
    if op.get("rawId") and op["rawId"] not in existing_ids:
        broken.append((label, "rawId", op["rawId"]))
    if op.get("semiId") and op["semiId"] not in existing_ids:
        broken.append((label, "semiId", op["semiId"]))

if broken:
    print("!!! БИТЫЕ ССЫЛКИ:", broken)
else:
    print("Ссылки в рецептах, sourceId и операциях целые, битых нет.")

with open(DB_PATH, "w", encoding="utf-8") as f:
    json.dump(db, f, ensure_ascii=False, indent=2)

print(f"ИТОГО продуктов в базе: {len(db['products'])}")
