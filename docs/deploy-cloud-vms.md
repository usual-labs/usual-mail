# Deploy Usual Mail on a cloud VM

Both templates run the published Usual Mail image behind Caddy on Ubuntu 24.04. Your account pays for the VM,
disks and public IPv4 address. You need your SSH public key, your current public IPv4 address for SSH access,
and your email to reserve the dashboard. The templates have been checked locally. A first install on each cloud
and certificate issuance on a public domain still need verification.

## Azure

1. Use the README’s [Deploy to Azure button](../README.md#deploy-your-own), or open
   [Custom deployment](https://portal.azure.com/#create/Microsoft.Template), choose **Build your own template
   in the editor**, then **Load file** and select [main.json](../deploy/azure/main.json) from your copy.
2. Select a subscription, a new resource group, and a region with the selected VM size. Enter your email, SSH
   public key and public IPv4 address. Review and create the resources. The default VM is a `Standard_B2ls_v2`
   with a separate 20 GiB managed data disk.
3. In the completed deployment’s **Outputs**, copy `dashboard` for the HTTPS address and `sshHost` for the SSH
   destination. Azure supplies the DNS name. Continue with [first sign-in](#first-sign-in).

Deleting the VM detaches its mail disk. Deleting the resource group also deletes the disk, so copy a backup
outside the group first.

## AWS

1. Download [cloudformation.yaml](../deploy/aws/cloudformation.yaml). Open
   [CloudFormation](https://console.aws.amazon.com/cloudformation/home#/stacks/create/template) in your AWS region,
   choose **Create stack** if prompted, then **Upload a template file** and select the downloaded YAML.
2. Give the stack a name. Select a VPC, a public subnet with a route to an internet gateway, the subnet’s
   availability zone, and an EC2 key pair whose private key you hold. Enter your public IPv4 address, owner email
   and a domain you control, such as `mail.example`. Review and create the stack. It creates a `t3.small`, an
   Elastic IP and a separate encrypted 20 GiB EBS volume.
3. Open the stack’s **Outputs** and point your domain’s DNS **A** record at `PublicIPv4`. Use only the IPv4
   record for this host. SSH as `ubuntu` at `PublicIPv4` with the selected key. After DNS resolves, Caddy can
   issue the certificate for the `Dashboard` address. Continue with [first sign-in](#first-sign-in).

The stack retains the mail volume on deletion. Before deleting a stack in use, take a backup and stop the VM.
The retained volume continues to incur storage charges until you remove it.

## First sign-in

The VM can appear ready while Ubuntu is still installing Docker. Connect over SSH and run:

```sh
sudo cloud-init status --wait
cd /opt/usual-mail
sudo docker compose ps
sudo docker compose exec usual-mail cat /data/owner-pairing-code
```

Check that `/healthz` at your public HTTPS address returns `{"ok":true}`. Open that address, choose **Sign in
with a pairing code**, enter the code you read over SSH, then set your password under **Account**. The owner
email blocks public password claims from the first start. You can add [your Google client](google-setup.md)
later to connect Gmail. Its redirect address is your HTTPS origin followed by `/v1/google/callback`.

If startup fails, check `/var/log/cloud-init-output.log` on the VM. For HTTPS, check the DNS record and
`sudo docker compose logs caddy` in `/opt/usual-mail`. Both templates allow incoming TCP on 80 and 443 and
restrict port 22 to the IPv4 address you entered.

## Backups and updates

The data disk mounts at `/var/lib/docker`. The mail volume there holds the database and its encryption key.
Follow the [Docker backup and restore steps](deploy.md#docker-on-a-server-of-your-own) in `/opt/usual-mail`
with `sudo docker compose`. Keep an off-host copy of the backup and of `/opt/usual-mail/.env`.

To update, back up first. Edit the Usual Mail image tag in `/opt/usual-mail/compose.yaml` to the release you want,
then run `sudo docker compose pull && sudo docker compose up -d --wait` there. The same mail volume stays mounted.
