#!/usr/bin/env python3
"""Generate new ORS/connection config from a 146 Connector + ORS config.

The 146 files are INI-like:
  KEY = value
  [EXCHANGE]
  KEY = value

New output is YAML without requiring PyYAML.
"""

from __future__ import annotations

import argparse
import re
from collections import OrderedDict
from pathlib import Path


def parse_config(path: Path) -> tuple[dict[str, str], OrderedDict[str, dict[str, str]]]:
    globals_: dict[str, str] = {}
    sections: OrderedDict[str, dict[str, str]] = OrderedDict()
    current: str | None = None

    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith(";"):
            continue
        if line.startswith("[") and line.endswith("]"):
            current = line[1:-1].strip()
            sections.setdefault(current, {})
            continue
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if current is None:
            globals_[key] = value
        else:
            sections[current][key] = value
    return globals_, sections


def csv(value: str | None) -> list[str]:
    if not value:
        return []
    return [item.strip() for item in value.split(",") if item.strip()]


def positive_int(value: str | None) -> int | None:
    if value is None or value.strip() == "":
        return None
    try:
        number = int(value)
    except ValueError:
        return None
    return number if number > 0 else None


def slug(value: str) -> str:
    value = value.lower()
    return re.sub(r"[^a-z0-9]+", "-", value).strip("-") or "ors"


def yaml_str(value: str) -> str:
    return '"' + value.replace('"', '\\"') + '"'


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--connector", required=True, type=Path)
    parser.add_argument("--ors", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()

    connector_globals, connector_sections = parse_config(args.connector)
    ors_globals, _ = parse_config(args.ors)

    exchanges = csv(connector_globals.get("EXCHANGES"))
    if not exchanges:
        raise SystemExit("Connector config has no EXCHANGES")

    broker_id = ors_globals.get("BROKER_ID", "")
    default_investor = ors_globals.get("INVESTOR_ID", "")

    # Group exchange sections that point at the same ORS queues.
    groups: OrderedDict[tuple[int, int, int], list[tuple[str, dict[str, str]]]] = OrderedDict()
    skipped: list[str] = []

    for exchange in exchanges:
        section = connector_sections.get(exchange, {})
        client_key = positive_int(section.get("CLIENTSTORESHMKEY"))
        request_key = positive_int(section.get("ORSREQUESTSHMKEY"))
        response_key = positive_int(section.get("ORSRESPONSESHMKEY"))
        if not (client_key and request_key and response_key):
            skipped.append(exchange)
            continue
        group_key = (client_key, request_key, response_key)
        groups.setdefault(group_key, []).append((exchange, section))

    used_streams: set[int] = set()
    for group in groups.values():
        for _, section in group:
            for raw in csv(section.get("MDSHMKEY")):
                value = positive_int(raw)
                if value:
                    used_streams.add(value)
            for key in ("ORSREQUESTSHMKEY", "ORSRESPONSESHMKEY"):
                value = positive_int(section.get(key))
                if value:
                    used_streams.add(value)

    def next_free(seed: int) -> int:
        value = max(seed, 1)
        while value in used_streams:
            value += 1
        used_streams.add(value)
        return value

    ors_entries: list[dict[str, object]] = []
    connection_entries: list[dict[str, object]] = []

    for index, (group_key, members) in enumerate(groups.items(), start=1):
        client_key, request_key, response_key = group_key
        first_exchange = members[0][0]
        ors_id = f"ors-{slug(first_exchange)}-{index:02d}"

        md_keys: list[int] = []
        for _, section in members:
            for raw in csv(section.get("MDSHMKEY")):
                value = positive_int(raw)
                if value and value not in md_keys:
                    md_keys.append(value)
        market_data = md_keys[0] if md_keys else next_free(1001)
        state = next_free(response_key + 1)
        session = next_free(response_key + 3)

        connection_entries.append({
            "id": ors_id,
            "marketData": market_data,
            "command": request_key,
            "execution": response_key,
            "state": state,
            "session": session,
            "extraMd": md_keys[1:],
        })

        accounts = []
        for exchange, _section in members:
            investor = ors_globals.get(f"INVESTOR_ID_{exchange.upper()}") or default_investor
            accounts.append({
                "exchange": exchange,
                "brokerId": broker_id,
                "investorId": investor,
                "secretRef": f"secret://ctp/{broker_id}/{investor}",
            })

        ors_entries.append({
            "id": ors_id,
            "adapter": "ctp" if default_investor else "other-venue",
            "accounts": accounts,
        })

    lines: list[str] = []
    lines.append("connections:")
    for entry in connection_entries:
        lines.append(f"  {entry['id']}:")
        lines.append("    channel: aeron:ipc")
        lines.append("    streams:")
        lines.append(f"      marketData: {entry['marketData']}")
        lines.append(f"      command: {entry['command']}")
        lines.append(f"      execution: {entry['execution']}")
        lines.append(f"      state: {entry['state']}")
        lines.append(f"      session: {entry['session']}")
        extra = entry["extraMd"]
        if isinstance(extra, list) and extra:
            lines.append(f"      # 146 extra MDSHMKEY: {', '.join(map(str, extra))}")
        lines.append("")

    lines.append("ors:")
    for entry in ors_entries:
        lines.append(f"  - id: {entry['id']}")
        lines.append(f"    adapter: {entry['adapter']}")
        lines.append("    accounts:")
        for account in entry["accounts"]:
            lines.append(f"      - exchange: {account['exchange']}")
            lines.append(f"        brokerId: {yaml_str(str(account['brokerId']))}")
            lines.append(f"        investorId: {yaml_str(str(account['investorId']))}")
            lines.append(f"        secretRef: {account['secretRef']}")
        lines.append("")

    if skipped:
        lines.append("# skipped exchanges without complete ORS keys:")
        for exchange in skipped:
            lines.append(f"#   {exchange}")
        lines.append("")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text("\n".join(lines), encoding="utf-8")

    print(f"wrote {args.out}")
    print(f"connections={len(connection_entries)} ors={len(ors_entries)} skipped={skipped}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
