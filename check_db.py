import sqlite3
import os
path = os.path.join(os.path.dirname(__file__), 'app.db')
print('DB exists:', os.path.exists(path))
if not os.path.exists(path):
    raise SystemExit(1)
conn = sqlite3.connect(path)
cur = conn.cursor()
print('tables:', [row[0] for row in cur.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()])
for tbl in ['users', 'data', 'notices']:
    try:
        cnt = cur.execute(f'SELECT count(*) FROM {tbl}').fetchone()[0]
        print(tbl, cnt)
    except Exception as e:
        print(tbl, 'ERR', e)
conn.close()