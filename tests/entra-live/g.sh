# usage: source g.sh ; G GET path [body]  (council tenant);  O GET path [body] (OCN tenant)
_ct(){ az account get-access-token --subscription 89d21d40-b5b2-4a6a-821f-627cce74548e --resource-type ms-graph --query accessToken -o tsv; }
_ot(){ az account get-access-token --tenant 41d5d96e-7342-40b7-baa6-78ed73da6626 --resource-type ms-graph --query accessToken -o tsv; }
G(){ local m=$1 p=$2; shift 2; curl -sS -X $m -H "Authorization: Bearer ${CT:=$(_ct)}" -H 'content-type: application/json' "https://graph.microsoft.com/$p" ${1:+--data "$1"}; }
O(){ local m=$1 p=$2; shift 2; curl -sS -X $m -H "Authorization: Bearer ${OT:=$(_ot)}" -H 'content-type: application/json' "https://graph.microsoft.com/$p" ${1:+--data "$1"}; }
