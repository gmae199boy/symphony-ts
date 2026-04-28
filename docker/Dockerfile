# Symphony worker image
#
# Contains Node 24 + Claude Code CLI + git/gh.
# This is the container where the agent (Claude) actually runs per-issue.
#
# Build:
#   docker build -t symphony-worker:latest -f docker/Dockerfile .
#
# The container is started with `sleep infinity` by the orchestrator and all
# actual work is done via `docker exec`. The host ~/.claude directory is
# bind-mounted read-only at /home/worker/.claude so that Claude Code can
# authenticate using the operator's existing session.

FROM node:24-bookworm-slim

# Basic development tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    jq \
    ca-certificates \
    bash \
    gh \
    sudo \
    openssh-client \
    make \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# semgrep 설치 (정적 분석 도구) - system-wide 설치로 worker 유저도 접근 가능
RUN pip3 install --break-system-packages semgrep

# Create a non-root worker user
# --dangerously-skip-permissions is blocked when running as root
RUN useradd -m -s /bin/bash worker && \
    echo "worker ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

USER worker

# Default workspace directory
RUN sudo mkdir -p /workspace && sudo chown worker:worker /workspace
WORKDIR /workspace

# Claude Code auth directory placeholder (mounted from host at runtime)
# -v ~/.claude:/home/worker/.claude:ro
RUN mkdir -p /home/worker/.claude

# Verify installations
RUN node --version && npm --version && claude --version || true

CMD ["sleep", "infinity"]
