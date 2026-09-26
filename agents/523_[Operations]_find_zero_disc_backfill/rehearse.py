import pathlib
import subprocess
import sys

repo = pathlib.Path(__file__).resolve().parents[2]
script = repo / 'test' / 'find-zero-d1-rehearsal' / 'rehearse.ps1'
result = subprocess.run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(script)], cwd=repo)
sys.exit(result.returncode)
