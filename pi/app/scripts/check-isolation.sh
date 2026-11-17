#!/usr/bin/env bash
# Проверка приватности зон: чужие и рабочий Ассистент не проходят внутрь.
# Запуск на Pi: bash /srv/dvoretsky/app/scripts/check-isolation.sh
set -uo pipefail
ROOT=${HELPER_ROOT:-/srv/dvoretsky}
fail=0

deny() { # $1 — кто, $2 — что делает, $3 — команда
	if eval "$3" >/dev/null 2>&1; then
		echo "✖ $1 может: $2"; fail=1
	else
		echo "✔ $1 не может: $2"
	fi
}

deny "Алина" "читать память владельца" "sudo -u dv-aliiinam test -r $ROOT/users/livbig/memory.db"
deny "Алина" "читать правила владельца" "sudo -u dv-aliiinam test -r $ROOT/users/livbig/work/AGENTS.md"
deny "Алина" "перечислить каталог владельца" "sudo -u dv-aliiinam ls $ROOT/users/livbig"
deny "владелец" "читать память Алины" "sudo -u dv-livbig test -r $ROOT/users/aliiinam/memory.db"
deny "владелец" "читать правила Алины" "sudo -u dv-livbig test -r $ROOT/users/aliiinam/work/AGENTS.md"
deny "Ассистент (minibrick)" "читать зону владельца" "sudo -u minibrick test -r $ROOT/users/livbig/work/AGENTS.md"
deny "Ассистент (minibrick)" "читать зону Алины" "sudo -u minibrick test -r $ROOT/users/aliiinam/work/AGENTS.md"

echo "---"
if [ "$fail" -eq 0 ]; then echo "изоляция зон в порядке"; else echo "ЕСТЬ ПРОБЛЕМЫ ИЗОЛЯЦИИ"; exit 1; fi
