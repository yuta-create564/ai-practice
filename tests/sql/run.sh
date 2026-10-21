#!/bin/sh
# ローカルの Postgres で supabase/schema.sql をテストする。 使い方: PGHOST=... PGPORT=... sh tests/sql/run.sh
set -e
cd "$(dirname "$0")/../.."
P="psql -U ${PGUSER:-postgres} -v ON_ERROR_STOP=1 -q -o /dev/null"
$P -c "drop database if exists eigo_test" -c "create database eigo_test" 2>/dev/null
$P -d eigo_test -f tests/sql/mock_supabase.sql
$P -d eigo_test -f supabase/schema.sql 2>/dev/null
$P -d eigo_test -f supabase/schema.sql 2>/dev/null   # 2回実行しても壊れないこと
$P -d eigo_test -f tests/sql/test_schema.sql 2>&1 | sed -n 's/.*NOTICE:  //p; s/.*\(ERROR.*\)/\1/p'
