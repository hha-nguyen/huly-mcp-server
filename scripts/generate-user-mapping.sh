#!/bin/bash

echo "export const USER_MAPPING: Record<string, string> = {"

ssh root@178.128.28.215 "docker exec huly_v7-cockroach-1 cockroach sql --url='postgresql://selfhost:6b998a9b82e85f183cd68aa6c21977e0b584d44bcbbadc2734ac16c9d3407884@localhost:26257/defaultdb?sslmode=disable' -e \"SELECT _id, data->>'name' as name FROM contact WHERE data->>'name' IS NOT NULL ORDER BY data->>'name';\" 2>/dev/null" | grep -v '^_id' | grep -v '^---' | grep -v '^$' | while IFS=$'\t' read -r id name; do
  if [ -n "$name" ] && [ -n "$id" ]; then
    name_clean=$(echo "$name" | sed "s/'/\\\\'/g")
    name_reversed=$(echo "$name_clean" | awk -F',' '{if(NF==2) print $2","$1; else print $name_clean}')
    name_no_comma=$(echo "$name_clean" | sed 's/,//g')
    
    echo "  '${name_clean}': '${id}',"
    if [ "$name_reversed" != "$name_clean" ]; then
      echo "  '${name_reversed}': '${id}',"
    fi
    if [ "$name_no_comma" != "$name_clean" ]; then
      echo "  '${name_no_comma}': '${id}',"
    fi
  fi
done

echo "};"
