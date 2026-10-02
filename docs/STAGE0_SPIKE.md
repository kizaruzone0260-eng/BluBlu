# Этап 0 — спайк: созвон между двумя устройствами

Цель критерия приёмки: учитель и ученик соединяются из **двух разных сетей**
(например, домашний Wi-Fi и мобильный hotspot), камера + микрофон + демонстрация
экрана со звуком работают. Это самый рискованный блок ТЗ — без него дальше не идти.

## Предварительные условия

1. VM Oracle Free: ARM64 (aarch64), Ubuntu 24.04, Docker + compose-plugin.
2. Домен указывает на IP сервера (DuckDNS или свой).
3. `.env` заполнен из `.env.example` (JWT_SECRET, LIVEKIT ключи, DOMAIN).

## Порты — открыть ДВАЖДЫ

**Security List (VCN) Oracle** И **на самой VM** (на Oracle-образах iptables
закрыт по умолчанию — использовать ufw):

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 7881/tcp    # LiveKit RTC over TCP
sudo ufw allow 7882/udp    # LiveKit RTC over UDP (mux, single port)
sudo ufw allow 3478/udp    # TURN
sudo ufw allow 5349/tcp    # TURN over TLS
sudo ufw enable
```

В панели Oracle: VCN → Security List → Ingress rules для тех же шести портов.

## Запуск

```bash
git clone <repo> && cd repo
cp .env.example .env && nano .env
cd deploy
docker compose up -d --build
docker compose ps          # все сервисы healthy
docker compose logs caddy --tail 50   # сертификат Let's Encrypt получен?
```

## Проверка спайка

1. Открыть `https://<домен>/spike` на двух устройствах в разных сетях.
2. Ввести одно имя комнаты на обоих, нажать Join.
3. Проверить: видео+аudio в обе стороны; «Демонстрация экрана» со звуком
   (Windows Chrome/Edge — системный звук; macOS/Firefox — только вкладка или нет).
4. Выключить Wi-Fi на втором устройстве, подключить мобильный интернет — переподключение.

## Если медиа не течёт (только signalement работает)

Проверить по порядку:
- `docker compose logs livekit` — есть ли ошибки портов;
- 7882/UDP доступен снаружи: `nc -zvu <ip> 7882` (или `nmap -sU -p 7882`);
- TURN: в логах клиента (chrome://webrtc-internals) — candidate типа `relay`
  появляется только когда TURN работает;
- domain в livekit.yaml совпадает с доменом API (иначе TURN/TLS сертификат не тот).

## Что фиксируем по итогам спайка

- Рабочие разрешения камеры/экрана на Windows Chrome и Edge, iPhone Safari,
  Android Chrome (ручная матрица раздела 9);
- Фактический потолок участников по CPU при одном уроке (htop во время звонка);
- Обновить `room.max_participants` при необходимости.
