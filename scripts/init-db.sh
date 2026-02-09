#!/bin/bash
set -e

# Create the nango database (used by nango-server)
# POSTGRES_USER is inherited from the postgres container env
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
    CREATE DATABASE nango;
EOSQL
