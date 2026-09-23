# Read-only: names the cards the matcher predicted for one user's scans, so the
# prediction can be checked against the photo that produced it.
# Run: gcloud compute ssh spotlight-backend-vm-small --zone us-central1-c \
#        --tunnel-through-iap --command "python3 -" < scan_query.py
import json
import os
import sqlite3

CARD_IDS = [
    "me55-158",
    "me55-148",
    "me55-135",
    "me55-130",
    "me55-129",
    "me55-54",
    "me55-151",
]

path = os.path.expanduser("~/spotlight/data/spotlight_scanner.sqlite")
connection = sqlite3.connect("file:%s?mode=ro" % path, uri=True)
connection.row_factory = sqlite3.Row

rows = [
    dict(row)
    for row in connection.execute(
        "SELECT id, name, number, set_name, rarity, language, artist FROM cards WHERE id IN (%s)"
        % ",".join("?" for _ in CARD_IDS),
        CARD_IDS,
    )
]

print(json.dumps(rows, default=str, indent=1))
