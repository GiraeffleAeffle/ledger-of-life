#!/usr/bin/env python3
"""Render this reviewed chart's deliberately small template subset, without Helm.

Unsupported syntax fails closed; the chart remains the single manifest source.
"""
import argparse
import ipaddress
import json
import pathlib
import re

VERSION = r'(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)'


def render_chart(chart, release_version, digest, artifact_sha256, token_revision='1', *, trust_sha256=None):
    chart = pathlib.Path(chart)
    if not re.fullmatch(VERSION, release_version):
        raise ValueError('Literal release version required')
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', digest) or digest == 'sha256:' + '0' * 64:
        raise ValueError('Immutable image digest required')
    if not re.fullmatch(r'[a-f0-9]{64}', artifact_sha256):
        raise ValueError('Signed artifact SHA-256 required')
    if not isinstance(trust_sha256, str) or not re.fullmatch(r'[a-f0-9]{64}', trust_sha256):
        raise ValueError('Public trust SHA-256 required')
    if not re.fullmatch(r'[a-zA-Z0-9-]{1,64}', token_revision):
        raise ValueError('Token revision required')
    identity = (chart / 'Chart.yaml').read_text()
    for field in ('version', 'appVersion'):
        match = re.search(r'^' + field + r':\s*[\"\']?([^\"\'\s]+)[\"\']?\s*$', identity, re.M)
        if not match or match[1] != release_version:
            raise ValueError('Chart version/appVersion must match releaseVersion')
    values = (chart / 'values.yaml').read_text()
    def scalar(field):
        matches = re.findall(r'^\s*' + field + r':\s*([^#\n]+?)\s*$', values, re.M)
        if len(matches) != 1:
            raise ValueError('Missing or ambiguous chart value: ' + field)
        value = matches[0].strip()
        return value[1:-1] if value.startswith(('"', "'")) and value[-1:] == value[:1] else value
    repository = scalar('repository')
    if repository != 'ghcr.io/giraeffleaeffle/stadtstack-mcp':
        raise ValueError('Unexpected image repository')
    resource_match = re.search(r'^web:\n  resources:\n((?:    [^\n]*\n)+)', values, re.M)
    source_match = re.search(r'^  haproxySources:\n((?:    - [^\n]*\n?)+)', values, re.M)
    if not resource_match or not source_match:
        raise ValueError('Unsupported resources or ingress sources format')
    resources = '\n'.join(' ' * 12 + line[4:] for line in resource_match[1].rstrip().splitlines())
    sources = [line.strip()[2:].strip() for line in source_match[1].splitlines()]
    for source in sources:
        ipaddress.ip_network(source, strict=True)
    replacements = {
        '.Release.Namespace': 'stadtstack-mcp',
        '.Values.releaseVersion | quote': json.dumps(release_version),
        '.Values.tokenSecretRevision | quote': json.dumps(token_revision),
        '.Values.revocationArtifactSha256 | quote': json.dumps(artifact_sha256),
        '.Values.revocationTrustSha256 | quote': json.dumps(trust_sha256),
        'include "civicMcp.image" . | quote': json.dumps(repository + ':' + release_version + '@' + digest),
        '.Values.ingress.clusterIssuer | quote': json.dumps(scalar('clusterIssuer')),
        'required "secretName must identify an existing governed Secret" .Values.secretName | quote': json.dumps(scalar('secretName')),
    }
    rendered = []
    for name in ('deployment.yaml', 'service.yaml', 'ingress.yaml', 'networkpolicy.yaml'):
        text = (chart / 'templates' / name).read_text()
        text = text.replace('{{- include "civicMcp.contract" . }}\n', '')
        text = re.sub(r'^\s*{{- toYaml .Values.web.resources \| nindent 12 }}', lambda _: resources, text, flags=re.M)
        def expand_sources(match):
            indent, body = match[1], match[2]
            return ''.join(body.replace('{{ . | quote }}', json.dumps(source)) for source in sources).rstrip('\n')
        text = re.sub(r'^([ ]*){{- range .Values.ingress.haproxySources }}\n(.*?)^\1{{- end }}', expand_sources, text, flags=re.M | re.S)
        def replace(match):
            expression = match[1].strip()
            if expression not in replacements:
                raise ValueError('Unsupported chart expression: ' + expression)
            return replacements[expression]
        text = re.sub(r'{{\s*(.*?)\s*}}', replace, text)
        if '{{' in text or '}}' in text:
            raise ValueError('Unrendered chart expression')
        rendered.append(text.rstrip() + '\n')
    return '\n---\n'.join(rendered)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--chart', default=str(pathlib.Path(__file__).parent / 'chart'))
    parser.add_argument('--release-version', required=True)
    parser.add_argument('--image-digest', required=True)
    parser.add_argument('--revocation-artifact-sha256', required=True)
    parser.add_argument('--revocation-trust-sha256', required=True)
    parser.add_argument('--token-revision', default='1')
    args = parser.parse_args()
    print(render_chart(args.chart, args.release_version, args.image_digest, args.revocation_artifact_sha256, args.token_revision, trust_sha256=args.revocation_trust_sha256), end='')
