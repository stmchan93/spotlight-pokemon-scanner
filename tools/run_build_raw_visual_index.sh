#!/bin/zsh
set -euo pipefail

cd /Users/stephenchan/Code/spotlight

if [[ -f backend/.env ]]; then
  set -a
  source backend/.env
  set +a
fi

python_bin="python3"
if command -v python3.10 >/dev/null 2>&1; then
  python_bin="python3.10"
fi

venv_dir=".venv-raw-visual-poc"
if [[ ! -d "$venv_dir" ]]; then
  "$python_bin" -m venv "$venv_dir"
fi

source "$venv_dir/bin/activate"
python -m pip install --upgrade pip >/dev/null
python -m pip install -r tools/requirements_raw_visual_poc.txt >/dev/null

python -u tools/build_raw_visual_index.py "$@"
