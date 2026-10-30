"""Open a zip with Python's own reader and print: integrity result, then name + sha256 per entry."""
import hashlib
import json
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as z:
    bad = z.testzip()  # CRC-checks every entry; None means all good
    out = {
        "testzip": bad,
        "entries": [[i.filename, hashlib.sha256(z.read(i)).hexdigest(), i.compress_type] for i in z.infolist()],
    }
print(json.dumps(out))
