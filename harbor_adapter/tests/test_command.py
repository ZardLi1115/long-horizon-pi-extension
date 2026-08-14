import shlex
import unittest

from harbor_adapter.command import build_pi_command


class BuildPiCommandTests(unittest.TestCase):
    def test_includes_explicit_long_horizon_extension_and_disables_discovery(self):
        command = build_pi_command(
            instruction="fix the parser",
            provider="anthropic",
            model="claude-sonnet-4-5",
            extension_path="/tmp/long horizon/index.ts",
            resume=False,
            cli_flags="",
        )

        self.assertIn("--no-extensions", command)
        self.assertIn("--extension '/tmp/long horizon/index.ts'", command)
        self.assertIn("--provider anthropic", command)
        self.assertIn("--model claude-sonnet-4-5", command)
        self.assertTrue(
            command.endswith(
                "'fix the parser' 2>&1 </dev/null | "
                "grep -v '\"type\":\"message_update\"' | "
                "stdbuf -oL tee /logs/agent/pi/pi.txt"
            )
        )

    def test_quotes_instruction_and_runtime_values_as_single_shell_words(self):
        command = build_pi_command(
            instruction="fix; echo SHOULD_NOT_RUN",
            provider="open ai",
            model="model's id",
            extension_path="/tmp/with space/index.ts",
            resume=True,
            cli_flags="--thinking high",
        )

        self.assertIn("--continue", command)
        self.assertIn("--provider 'open ai'", command)
        self.assertIn("--model " + shlex.quote("model's id"), command)
        self.assertIn("'fix; echo SHOULD_NOT_RUN'", command)
        self.assertIn("--thinking high", command)
