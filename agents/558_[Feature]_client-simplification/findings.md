# Findings

- 主目录存在用户其他工作，所有实现使用隔离 worktree。
- 音流's official documentation at https://music.aqzscn.cn/docs/intro/ lists Subsonic among supported services.
- Symfonium's official site at https://www.symfonium.app/ lists Subsonic and OpenSubsonic support.
- The official Ultrasonic website at https://ultrasonic.gitlab.io/ links its current project and describes it as a Subsonic-compatible client.
- The official Supersonic project repository at https://github.com/supersonic-app/supersonic describes Subsonic/OpenSubsonic support.
- The view already gates credential listing and mutations on `canManageCredentials`, and uses `auth/credentials/list`, `/create`, `/update`, and `/delete`; retain these exactly.
