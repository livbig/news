FROM python:3.14-slim

RUN apt-get update && apt-get install -y --no-install-recommends tzdata \
    && rm -rf /var/lib/apt/lists \
    && useradd -m -u 1000 bot

ENV TZ=Europe/Moscow \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY pipeline/ pipeline/
COPY bot/ bot/

RUN mkdir -p logs && chown -R bot:bot /app
USER bot

EXPOSE 7860
CMD ["python3", "-m", "bot"]
