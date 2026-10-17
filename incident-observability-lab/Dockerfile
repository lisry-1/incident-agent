FROM python:3.14-slim
WORKDIR /app
COPY app.py log_exporter.py trace_exporter.py /app/
USER 10001:10001
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
EXPOSE 8080
CMD ["python", "/app/app.py"]
