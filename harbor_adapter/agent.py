from __future__ import annotations

from harbor.agents.installed.base import with_prompt_template
from harbor.agents.installed.pi import Pi
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from harbor_adapter.command import build_pi_command
from harbor_adapter.staging import (
    require_task_artifacts,
    repository_root,
    stage_local_extension,
)


class LongHorizonPi(Pi):
    """Harbor Pi agent that explicitly loads the local Long Horizon extension."""

    _long_horizon_extension: str | None = None

    @staticmethod
    def name() -> str:
        return "long-horizon-pi"

    async def setup(self, environment: BaseEnvironment) -> None:
        await require_task_artifacts(environment)
        await super().setup(environment)
        extension_path = await stage_local_extension(
            self,
            environment,
            repository_root(),
        )
        self._long_horizon_extension = extension_path.as_posix()

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        extension_path = self._long_horizon_extension
        if extension_path is None:
            raise RuntimeError("Long Horizon extension was not staged during setup")
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("Model name must be in the format provider/model_name")

        provider, model = self.model_name.split("/", 1)
        access = self.model_connection
        provider = access.provider or provider
        env = dict(access.env)
        if provider == "anthropic" and (
            oauth_token := self._get_env("ANTHROPIC_OAUTH_TOKEN")
        ):
            env["ANTHROPIC_OAUTH_TOKEN"] = oauth_token

        skills_command = self._build_register_skills_command()
        if skills_command:
            await self.exec_as_agent(environment, command=skills_command)

        await self.exec_as_agent(
            environment,
            command=build_pi_command(
                instruction=instruction,
                provider=provider,
                model=model,
                extension_path=extension_path,
                resume=self._resume,
                cli_flags=self.build_cli_flags(),
            ),
            env=env,
        )
