# Docker — Quick Reference

## Images

| Command | Description |
|---------|-------------|
| `docker build -t name:tag .` | Build image from Dockerfile |
| `docker build --no-cache -t name .` | Build without cache |
| `docker images` | List local images |
| `docker rmi image` | Remove image |
| `docker image prune` | Remove dangling images |
| `docker pull image:tag` | Pull from registry |
| `docker push image:tag` | Push to registry |
| `docker tag src dst` | Tag an image |
| `docker save -o file.tar image` | Export image to tar |
| `docker load -i file.tar` | Load image from tar |
| `docker history image` | Show image layers |

## Containers

| Command | Description |
|---------|-------------|
| `docker run image` | Run container |
| `docker run -d image` | Run detached |
| `docker run -p 8080:80 image` | Map host:container port |
| `docker run -v /host:/container image` | Bind mount |
| `docker run --rm image` | Auto-remove on exit |
| `docker run -e VAR=val image` | Set environment variable |
| `docker run --name myapp image` | Named container |
| `docker run -it image bash` | Interactive shell |
| `docker ps` | List running containers |
| `docker ps -a` | List all containers |
| `docker stop name` | Graceful stop (SIGTERM) |
| `docker kill name` | Force stop (SIGKILL) |
| `docker rm name` | Remove container |
| `docker rm $(docker ps -aq)` | Remove all stopped containers |

## Inspection & Debugging

| Command | Description |
|---------|-------------|
| `docker logs name` | Show container logs |
| `docker logs -f name` | Follow logs |
| `docker logs --tail 100 name` | Last 100 lines |
| `docker exec -it name bash` | Shell into running container |
| `docker inspect name` | Full container JSON metadata |
| `docker stats` | Live resource usage |
| `docker top name` | Running processes in container |
| `docker cp src name:/dest` | Copy file into container |
| `docker diff name` | Show filesystem changes |

## Networks & Volumes

| Command | Description |
|---------|-------------|
| `docker network ls` | List networks |
| `docker network create mynet` | Create network |
| `docker run --network mynet image` | Attach to network |
| `docker volume ls` | List volumes |
| `docker volume create myvol` | Create volume |
| `docker run -v myvol:/data image` | Mount named volume |
| `docker volume prune` | Remove unused volumes |

## Docker Compose

| Command | Description |
|---------|-------------|
| `docker compose up` | Start services |
| `docker compose up -d` | Start detached |
| `docker compose up --build` | Force rebuild |
| `docker compose down` | Stop and remove containers |
| `docker compose down -v` | Also remove volumes |
| `docker compose logs -f svc` | Follow service logs |
| `docker compose exec svc bash` | Shell into service |
| `docker compose ps` | List service status |
| `docker compose restart svc` | Restart a service |
| `docker compose pull` | Pull latest images |

## Dockerfile Patterns

| Instruction | Description |
|------------|-------------|
| `FROM base:tag` | Base image |
| `RUN cmd` | Execute at build time |
| `COPY src dest` | Copy files into image |
| `WORKDIR /path` | Set working directory |
| `ENV VAR=value` | Set environment variable |
| `EXPOSE 8080` | Document exposed port |
| `CMD ["app"]` | Default command (overridable) |
| `ENTRYPOINT ["app"]` | Fixed entrypoint |
| `ARG NAME=default` | Build-time variable |
| `HEALTHCHECK CMD curl ...` | Container health probe |
