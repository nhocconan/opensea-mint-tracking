FROM python:3.13-alpine
WORKDIR /app
COPY monitor.py /app/monitor.py
RUN adduser -D -u 10001 watcher && mkdir /data && chown watcher:watcher /data
USER watcher
ENV STATE_DIR=/data PYTHONUNBUFFERED=1
ENTRYPOINT ["python", "/app/monitor.py"]
