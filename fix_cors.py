
import re, sys

f = r'C:\Users\broch\RRN-Backend-Deploy\server.js'
with open(f, encoding='utf-8') as fh:
    c = fh.read()

print('File:', len(c), 'chars')

# Find ALLOWED_ORIGINS or cors origin array
idx = c.find('ALLOWED_ORIGINS')
if idx >= 0:
    print('ALLOWED_ORIGINS at:', idx)
    print(repr(c[idx:idx+300]))
else:
    # Find cors origin function
    idx2 = c.find('allowedOrigins')
    idx3 = c.find("origin:")
    print('allowedOrigins:', idx2)
    print('origin config:', idx3)
    if idx3 >= 0:
        print(repr(c[idx3:idx3+400]))

# Add localhost:8080 wherever localhost appears in cors config
patterns = [
    ("'http://localhost:3001'", "'http://localhost:3001','http://localhost:8080'"),
    ('"http://localhost:3001"', '"http://localhost:3001","http://localhost:8080"'),
    ("localhost:3001,", "localhost:3001,\n  'http://localhost:8080',"),
]
fixed = False
for old, new in patterns:
    if old in c and new not in c:
        c = c.replace(old, new, 1)
        print('Fixed:', old[:40])
        fixed = True
        break

if not fixed:
    # Try wildcard fallback - add origin: '*' temporarily
    # Find the cors() call
    cors_idx = c.find('cors(')
    print('cors( at:', cors_idx)
    print(repr(c[cors_idx:cors_idx+300]))

with open(f, 'w', encoding='utf-8') as fh:
    fh.write(c)
print('DONE')
