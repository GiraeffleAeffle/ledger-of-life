{{- define "civicMcp.contract" -}}
{{- if ne .Release.Namespace "stadtstack-mcp" -}}
{{- fail "Install only in the governed existing namespace stadtstack-mcp" -}}
{{- end -}}
{{- if ne .Release.Name "civic-mcp" -}}
{{- fail "The governed release name must be civic-mcp" -}}
{{- end -}}
{{- $version := required "releaseVersion must equal the literal Git/image/package version" .Values.releaseVersion -}}
{{- if not (regexMatch "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$" $version) -}}
{{- fail "releaseVersion must be a literal stable numeric version, without a prefix" -}}
{{- end -}}
{{- if or (ne .Chart.AppVersion $version) (ne .Chart.Version $version) -}}
{{- fail "Chart version and appVersion must match releaseVersion and the canonical package version" -}}
{{- end -}}
{{- end -}}
{{- define "civicMcp.image" -}}
{{- if ne .Values.image.repository "ghcr.io/giraeffleaeffle/stadtstack-mcp" -}}
{{- fail "image.repository must be ghcr.io/giraeffleaeffle/stadtstack-mcp" -}}
{{- end -}}
{{- if not (regexMatch "^sha256:[a-f0-9]{64}$" .Values.image.digest) -}}
{{- fail "image.digest must be the owner-approved immutable sha256 digest from civic-mcp-image workflow" -}}
{{- end -}}
{{- printf "%s:%s@%s" .Values.image.repository .Values.releaseVersion .Values.image.digest -}}
{{- end -}}
