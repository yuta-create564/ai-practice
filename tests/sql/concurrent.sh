#!/bin/sh
# 同じ依頼が同時に2回届いても1件しか登録されないことを確かめる(run.sh の後に実行)
set -e
P="psql -U ${PGUSER:-postgres} -d eigo_test -v ON_ERROR_STOP=1 -qAt"
$P -c "update public.api_keys set revoked_at = null"
Q="set role service_role; select public.eigo_api_add(repeat('a',64), 'same-req', '[{\"type\":\"word\",\"en\":\"concurrency\",\"ja\":\"同時実行\"}]')::text from pg_sleep(0.2);"
$P -c "$Q" > /tmp/eigo_c1 & $P -c "$Q" > /tmp/eigo_c2 & $P -c "set role service_role; select public.eigo_api_add(repeat('a',64), 'other-req', '[{\"type\":\"word\",\"en\":\"Concurrency\",\"ja\":\"同時実行\"}]')::text from pg_sleep(0.2);" > /tmp/eigo_c3 & wait
N=$($P -c "select count(*) from public.items where en ilike 'concurrency'")
echo "同時に3回届いた依頼で登録された件数: $N"
[ "$N" = "1" ] && echo "ok: 同時の再送でも二重登録されない"
