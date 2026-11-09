# Math GP 🏁

24/7 YouTube live game: viewers join one of five F1 teams by commenting, solve sums (one easy, one hard ×2)
as fast as they can, and their points drive the cars around a real city. Chat votes the next track
(Istanbul, Ankara, İzmir); the city is drawn live from OpenStreetMap vector tiles, nothing is downloaded ahead.

- `web/` the game (MapLibre GL + OpenFreeMap for the city, Three.js for the cars, OSRM for the street loop)
- `stream/stream.py` renders the page on a virtual display, streams it with ffmpeg, feeds live chat in
- `.github/workflows/live.yml` chained runs + watchdog
- `data/leaderboard.json` all-time board and bans, saved by the stream

Map data © OpenStreetMap contributors (ODbL), tiles by OpenFreeMap. Music: Kenney, CC0.
