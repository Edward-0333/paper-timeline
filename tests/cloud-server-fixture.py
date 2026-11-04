"""Disposable Django WSGI instance for desktop integration. Never reads production config."""
import os
import sys
import json
import uuid
from pathlib import Path
from wsgiref.simple_server import make_server, WSGIRequestHandler

root, database = sys.argv[1:]
sys.path.insert(0, root)
os.environ.update(DJANGO_SETTINGS_MODULE='config.settings', DJANGO_DEBUG='true', DATABASE_ENGINE='sqlite', SQLITE_PATH=database,
                  DJANGO_SECRET_KEY='isolated-desktop-fixture', DJANGO_ALLOWED_HOSTS='127.0.0.1,localhost',
                  DJANGO_SECURE_SSL_REDIRECT='false', DJANGO_SESSION_COOKIE_SECURE='false', DJANGO_CSRF_COOKIE_SECURE='false')
import django
django.setup()
from django.core.management import call_command
from django.contrib.auth import get_user_model
from django.core.wsgi import get_wsgi_application
from django.utils import timezone
from apps.cloud.services import bind
from apps.cloud.models import CitationBatch
from apps.papers.models import Paper, PaperMetadata
from apps.cloud.legacy import migrate_all

call_command('migrate', verbosity=0)
user = get_user_model().objects.create_user(username='desktop-fixture', password='fixture-password')
seed = dict(title='Cloud integration fixture', authors=['Fixture Author'], year=2025, doi='10.1234/cloud-fixture', arxivId='')
binding = bind(user, uuid.uuid4(), 'server-fixture', True, 1, seed)
paper = binding.subscription.paper
record = dict(id='c'*64, title='Fixture citing paper', authors=['Fixture Author'], year=2026, publicationDate='2026', doi='10.1234/cloud-citing',
              arxivId='', abstract='', url='', venue='', sources=[dict(provider='openalex', id='W2')], firstSeenAt='2026-10-20', lastSeenAt='2026-10-21')
paper.latest_batch = CitationBatch.objects.create(paper=paper, citations=[record], providers=[dict(provider='openalex', status='success', message='', seedIds=['W1'], count=1)], status='success', last_success_at=timezone.now())
paper.last_success_at = timezone.now()
paper.status = 'success'
paper.save()
for title, doi in [('Legacy transfer fixture', '10.1234/legacy-transfer'), ('Legacy stop fixture', '')]:
    old = Paper.objects.create(owner=user, title=title)
    PaperMetadata.objects.create(paper=old, title=title, doi=doi)
migrate_all()

class Quiet(WSGIRequestHandler):
    def log_message(self, *args):
        pass

with make_server('127.0.0.1', 0, get_wsgi_application(), handler_class=Quiet) as server:
    print(json.dumps({'port': server.server_port}), flush=True)
    server.serve_forever()
