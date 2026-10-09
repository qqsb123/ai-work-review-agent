FROM python:3.13-slim
WORKDIR /app
COPY requirements*.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY scripts ./scripts
COPY sql ./sql
COPY .env.example ./.env.example
ENV HF_HOME=/app/.cache/huggingface
EXPOSE 3001
CMD ["sh", "-c", "python -m scripts.migrate && uvicorn app.main:app --host 0.0.0.0 --port 3001"]
