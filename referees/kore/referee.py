#!/usr/bin/env python3
"""kore_fleets 2-player referee for agent-chat training windows (the server copies this directory read-only at the
start of a window, so the rules can't move during it).

  referee.py probe <bot.py> <outdir>             your bot vs the official `balanced` bot, PROBE_SEEDS x both seats
  referee.py rank <outdir> <name>=<bot.py> ...   round robin, all pairs, RANK_SEEDS x both seats

Both print one JSON line last: probe {"rate", "games", "replay"}, rank {"standings": [{"name", "rate", "games"}],
"replays": [...]}. Replays are HTML files in outdir (one game per probe, one per pair in rank).
A bot is a single file defining agent(obs, config). Ties count half. A crash or timeout loses (reward None).
Probe seeds are public and the same every time (so probes compare); rank seeds are a different, fixed set.
"""
import json, os, sys
from concurrent.futures import ProcessPoolExecutor
from itertools import combinations

PROBE_SEEDS = [41000 + 7 * i for i in range(10)]
RANK_SEEDS = [52000 + 11 * i for i in range(10)]
WORKERS = 4  # ponytail: fixed; members' own experiments share the CPU during a window


def play(arg):
    seed, b0, b1, replay = arg
    from kaggle_environments import make
    env = make("kore_fleets", configuration={"randomSeed": seed})
    env.run([b0, b1])
    r = [s.reward for s in env.state]
    r = [x if x is not None else -1e9 for x in r]
    if replay:
        with open(replay, "w") as f:
            f.write(env.render(mode="html"))
    return 1.0 if r[0] > r[1] else 0.0 if r[0] < r[1] else 0.5


def games(a, b, seeds, replay):
    """a's score per game, a in both seats; the first game is saved as a replay."""
    out = []
    for i, s in enumerate(seeds):
        out.append((s, a, b, replay if i == 0 else None, False))
        out.append((s, b, a, None, True))
    return out


def run(gs):
    with ProcessPoolExecutor(WORKERS) as ex:
        res = list(ex.map(play, [g[:4] for g in gs]))
    return [1 - x if g[4] else x for g, x in zip(gs, res)]


def main():
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == "probe":
        bot, outdir = os.path.abspath(args[0]), args[1]
        name = os.path.splitext(os.path.basename(bot))[0] + ".html"
        sc = run(games(bot, "balanced", PROBE_SEEDS, os.path.join(outdir, name)))
        print(json.dumps({"rate": sum(sc) / len(sc), "games": len(sc), "replay": name}))
    elif cmd == "rank":
        outdir, bots = args[0], dict(a.split("=", 1) for a in args[1:])
        score = {n: 0.0 for n in bots}
        played = {n: 0 for n in bots}
        replays = []
        for x, y in combinations(bots, 2):
            name = f"{x}_vs_{y}.html"
            sc = run(games(os.path.abspath(bots[x]), os.path.abspath(bots[y]), RANK_SEEDS, os.path.join(outdir, name)))
            replays.append(name)
            score[x] += sum(sc); score[y] += len(sc) - sum(sc)
            played[x] += len(sc); played[y] += len(sc)
        st = sorted(({"name": n, "rate": score[n] / played[n] if played[n] else 0, "games": played[n]} for n in bots),
                    key=lambda s: -s["rate"])
        print(json.dumps({"standings": st, "replays": replays}))
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
