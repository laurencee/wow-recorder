import os

CWD = os.path.dirname(__file__)

NAME = "zone_changes"
LOG = f"{CWD}/../../logs/retail/{NAME}.txt"
OVERRUN = 0
SLEEPS = {
    "ZONE_CHANGE": 1,
}
