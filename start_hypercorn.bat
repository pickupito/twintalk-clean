@echo off
cd D:\AI
python -m hypercorn app:app -b 0.0.0.0:8443 --certfile cert.pem --keyfile key.pem