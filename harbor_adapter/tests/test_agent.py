import asyncio
import importlib.util
import sys
import types
import unittest
from pathlib import Path


def load_agent_class():
    base_module = types.ModuleType("harbor.agents.installed.base")
    base_module.with_prompt_template = lambda function: function

    pi_module = types.ModuleType("harbor.agents.installed.pi")

    class FakePi:
        _resume = False

        def __init__(self, logs_dir=None, model_name=None, **kwargs):
            self.model_name = model_name
            self.model_connection = types.SimpleNamespace(
                provider=None,
                env={},
            )
            self.commands = []

        @staticmethod
        def name():
            return "pi"

        async def setup(self, environment):
            return None

        async def exec_as_agent(self, environment, command, env=None):
            self.commands.append((command, env))

        def _build_register_skills_command(self):
            return None

        def build_cli_flags(self):
            return ""

        def _get_env(self, name):
            return None

    pi_module.Pi = FakePi

    environment_module = types.ModuleType("harbor.environments.base")
    environment_module.BaseEnvironment = object
    context_module = types.ModuleType("harbor.models.agent.context")
    context_module.AgentContext = object

    modules = {
        "harbor": types.ModuleType("harbor"),
        "harbor.agents": types.ModuleType("harbor.agents"),
        "harbor.agents.installed": types.ModuleType("harbor.agents.installed"),
        "harbor.agents.installed.base": base_module,
        "harbor.agents.installed.pi": pi_module,
        "harbor.environments": types.ModuleType("harbor.environments"),
        "harbor.environments.base": environment_module,
        "harbor.models": types.ModuleType("harbor.models"),
        "harbor.models.agent": types.ModuleType("harbor.models.agent"),
        "harbor.models.agent.context": context_module,
    }
    sys.modules.update(modules)

    module_path = Path(__file__).parents[1] / "agent.py"
    spec = importlib.util.spec_from_file_location(
        "harbor_adapter.agent_under_test",
        module_path,
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module.LongHorizonPi


class AgentContractTests(unittest.TestCase):
    def test_has_distinct_name(self):
        agent_class = load_agent_class()
        self.assertEqual(agent_class.name(), "long-horizon-pi")

    def test_run_uses_the_staged_extension_command(self):
        agent_class = load_agent_class()
        agent = agent_class(model_name="anthropic/test-model")
        agent._long_horizon_extension = "/tmp/long-horizon-pi-extension/index.ts"

        asyncio.run(agent.run("fix the parser", object(), object()))

        command = agent.commands[-1][0]
        self.assertEqual(command.count("--no-extensions"), 1)
        self.assertEqual(command.count("--extension"), 1)
        self.assertIn(
            "--extension /tmp/long-horizon-pi-extension/index.ts",
            command,
        )
