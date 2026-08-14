from __future__ import annotations

import shlex


def build_pi_command(
    *,
    instruction: str,
    provider: str,
    model: str,
    extension_path: str,
    resume: bool,
    cli_flags: str,
    session_dir: str = "/logs/agent/pi/sessions",
    output_file: str = "/logs/agent/pi/pi.txt",
) -> str:
    parts = [
        "pi",
        "--print",
        "--mode",
        "json",
        "--session-dir",
        shlex.quote(session_dir),
    ]
    if resume:
        parts.append("--continue")
    parts.extend(
        [
            "--no-extensions",
            "--extension",
            shlex.quote(extension_path),
            "--provider",
            shlex.quote(provider),
            "--model",
            shlex.quote(model),
        ]
    )
    if cli_flags:
        parts.append(cli_flags)
    parts.append(shlex.quote(instruction))
    return (
        ". ~/.nvm/nvm.sh; "
        + " ".join(parts)
        + " 2>&1 </dev/null | grep -v '\"type\":\"message_update\"' "
        + "| stdbuf -oL tee "
        + shlex.quote(output_file)
    )
