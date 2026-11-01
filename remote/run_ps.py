import base64
import json
import os
import re
import sys

import winrm

request = json.load(sys.stdin)
session = winrm.Session(
    f"http://{request['host']}:5985/wsman",
    auth=(os.environ["REMOTE_USER"], os.environ["REMOTE_PASSWORD"]),
    transport="ntlm",
)

# The packaged pywinrm crashes in run_ps when a command writes to stderr, so the encoded command is run directly.
script = "$ProgressPreference = 'SilentlyContinue'\n" + request["script"]
encoded = base64.b64encode(script.encode("utf-16-le")).decode()
result = session.run_cmd("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded])


def clean_stderr(raw: bytes) -> str:
    text = raw.decode(errors="replace")
    if text.startswith("#< CLIXML"):
        messages = re.findall(r'<S S="Error">(.*?)</S>', text, re.S)
        text = "".join(messages).replace("_x000D__x000A_", "\n")
    return text.strip()


print(json.dumps({
    "exitCode": result.status_code,
    "stdout": result.std_out.decode(errors="replace"),
    "stderr": clean_stderr(result.std_err),
}))
