.PHONY: all build dev up down test burst logs clean

all: build

build:
	npm run build

dev:
	npm run dev

up:
	docker compose up --build -d

down:
	docker compose down -v

test:
	npm test

burst:
	./burst.sh $(BASE_URL)

logs:
	docker compose logs -f app

clean:
	rm -rf dist node_modules
